#!/usr/bin/env python3
"""Fetch eBay market prices for Grimoire cards and write them to grimoire-prices.json.

The page itself can't talk to eBay: the API needs a client secret (which must never ship
in a public static page) and eBay doesn't allow browser cross-origin requests anyway. So
this script runs offline (locally or from the GitHub Action in .github/workflows), and the
page just reads the JSON it produces - same pattern as grimoire-data.json.

Uses the eBay Browse API (active "Buy It Now" listings), so the numbers are current asking
prices, not completed sales. Only cards whose rarity is NOT in --exclude are looked up
(by default Common and Rare are skipped, so L, SPL, SR, UR, SPR, ... are priced).

Credentials come from the environment:
    EBAY_CLIENT_ID      your app's Client ID (App ID)
    EBAY_CLIENT_SECRET  your app's Client Secret (Cert ID)

Usage:
    python3 tools/ebay_prices.py                      # all expansions, default settings
    python3 tools/ebay_prices.py --expansions BT01 BT02 --dry-run
    python3 tools/ebay_prices.py --marketplace EBAY_DE --exclude C R P
"""
import argparse
import base64
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
SCOPE = 'https://api.ebay.com/oauth/api_scope'
# Words in a listing title that mean it isn't a single copy of one card.
BUNDLE_WORDS = re.compile(r'\b(lot|bundle|set of|complete set|booster box|sealed|display|proxy|custom|playmat|sleeve)\b', re.I)


def get_token(client_id, client_secret):
    auth = base64.b64encode(f'{client_id}:{client_secret}'.encode()).decode()
    body = urllib.parse.urlencode({'grant_type': 'client_credentials', 'scope': SCOPE}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={
        'Authorization': f'Basic {auth}',
        'Content-Type': 'application/x-www-form-urlencoded',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)['access_token']


def search(token, query, marketplace, limit, category):
    params = {'q': query, 'limit': str(limit), 'filter': 'buyingOptions:{FIXED_PRICE}'}
    if category:
        params['category_ids'] = category
    req = urllib.request.Request(SEARCH_URL + '?' + urllib.parse.urlencode(params), headers={
        'Authorization': f'Bearer {token}',
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp).get('itemSummaries', [])
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** (attempt + 1))
                continue
            raise
    return []


def number_regex(number):
    """'BT01-001' -> matches BT01-001, BT1-001, BT01 001, BT01-1 (case-insensitive)."""
    m = re.match(r'([A-Za-z]+)0*(\d+)[-_ ]0*(\d+)$', number or '')
    if not m:
        return re.compile(re.escape(number or ''), re.I)
    prefix, setno, cardno = m.groups()
    return re.compile(rf'\b{prefix}0*{setno}[\s\-_]*0*{cardno}\b', re.I)


def title_matches(title, number_re, abbr, parallel, other_abbrs):
    """Keep listings that name this card number and, as far as a title can tell, this rarity.

    A parallel rarity (SPL, SPR, SSL, ...) must appear in the title as its own word. A base
    rarity (L, SR, UR) rarely does, so instead reject titles that name one of its parallels -
    otherwise a BT01-001 L would get priced with the much pricier BT01-001 SPL listings.
    """
    if not number_re.search(title) or BUNDLE_WORDS.search(title):
        return False
    words = set(re.findall(r'[A-Za-z]+', title.upper()))
    if parallel:
        return abbr.upper() in words
    return not any(o.upper() in words for o in other_abbrs)


def summarize(items, query, marketplace):
    by_currency = {}
    for it in items:
        price = it.get('price') or {}
        try:
            value = float(price['value'])
        except (KeyError, TypeError, ValueError):
            continue
        by_currency.setdefault(price.get('currency', ''), []).append((value, it))
    search_url = ebay_search_url(query, marketplace)
    if not by_currency:
        return {'count': 0, 'query': query, 'searchUrl': search_url}
    # mixed currencies can't be averaged - keep whichever currency most listings use
    currency, rows = max(by_currency.items(), key=lambda kv: len(kv[1]))
    values = sorted(v for v, _ in rows)
    cheapest = min(rows, key=lambda r: r[0])[1]
    return {
        'count': len(values),
        'currency': currency,
        'min': round(values[0], 2),
        'median': round(statistics.median(values), 2),
        'avg': round(statistics.fmean(values), 2),
        'max': round(values[-1], 2),
        'cheapestUrl': cheapest.get('itemWebUrl', ''),
        'query': query,
        'searchUrl': search_url,
    }


EBAY_DOMAINS = {'EBAY_US': 'ebay.com', 'EBAY_GB': 'ebay.co.uk', 'EBAY_DE': 'ebay.de', 'EBAY_FR': 'ebay.fr',
                'EBAY_IT': 'ebay.it', 'EBAY_ES': 'ebay.es', 'EBAY_AU': 'ebay.com.au', 'EBAY_CA': 'ebay.ca'}


def ebay_search_url(query, marketplace):
    return f'https://www.{EBAY_DOMAINS.get(marketplace, "ebay.com")}/sch/i.html?' + urllib.parse.urlencode({'_nkw': query})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', default=str(ROOT / 'grimoire-data.json'))
    ap.add_argument('--out', default=str(ROOT / 'grimoire-prices.json'))
    ap.add_argument('--exclude', nargs='*', default=['C', 'R'], help='rarity abbreviations to skip (default: C R)')
    ap.add_argument('--expansions', nargs='*', help='only these expansion abbreviations (default: all)')
    ap.add_argument('--game', default='Nivel Arena', help='game name prefixed to every search')
    ap.add_argument('--template', default='{game} {number} {abbr}',
                    help='search query template; fields: game, number, abbr, rarity, name (default: "%(default)s")')
    ap.add_argument('--marketplace', default='EBAY_US')
    ap.add_argument('--category', default='', help='optional eBay category id, e.g. 183454 (CCG individual cards)')
    ap.add_argument('--limit', type=int, default=50, help='listings fetched per search (max 200)')
    ap.add_argument('--delay', type=float, default=0.3, help='seconds between API calls')
    ap.add_argument('--dry-run', action='store_true', help='print the searches without calling eBay')
    args = ap.parse_args()

    data = json.loads(Path(args.data).read_text(encoding='utf-8'))
    excluded = {a.upper() for a in args.exclude}
    wanted_exp = {a.upper() for a in args.expansions} if args.expansions else None

    token = None
    if not args.dry_run:
        cid, secret = os.environ.get('EBAY_CLIENT_ID'), os.environ.get('EBAY_CLIENT_SECRET')
        if not cid or not secret:
            sys.exit('Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (or use --dry-run).')
        token = get_token(cid, secret)

    out_path = Path(args.out)
    previous = json.loads(out_path.read_text(encoding='utf-8')).get('cards', {}) if out_path.exists() else {}
    cards_out = {}
    cache = {}  # same number + rarity (e.g. two SPL arts) -> one API call
    failures = 0

    for sysd in data.get('systems', []):
        rarities = {r['id']: r for r in sysd.get('rarities', [])}
        parallel_abbrs = {r.get('abbr', '') for r in rarities.values() if r.get('parallel')}
        for exp in sysd.get('expansions', []):
            if wanted_exp and (exp.get('abbreviation') or '').upper() not in wanted_exp:
                continue
            # rarities each card number appears in, so a base rarity can reject its parallels' listings
            abbrs_by_number = {}
            for c in exp.get('cards', []):
                r = rarities.get(c.get('rarityId'))
                if r:
                    abbrs_by_number.setdefault(c.get('number'), set()).add(r.get('abbr', ''))
            for c in exp.get('cards', []):
                r = rarities.get(c.get('rarityId'))
                abbr = (r or {}).get('abbr', '')
                if not r or abbr.upper() in excluded or not c.get('number'):
                    continue
                query = args.template.format(game=args.game, number=c['number'], abbr=abbr,
                                             rarity=r.get('name', ''), name=c.get('name', '')).strip()
                if args.dry_run:
                    print(f'{exp.get("abbreviation", ""):5} {c["number"]:9} {abbr:4} {query}')
                    continue
                key = (c['number'], abbr)
                if key not in cache:
                    try:
                        items = search(token, query, args.marketplace, args.limit, args.category)
                        parallel_others = (abbrs_by_number.get(c['number'], set()) - {abbr}) & parallel_abbrs
                        nre = number_regex(c['number'])
                        items = [it for it in items if title_matches(it.get('title', ''), nre, abbr, r.get('parallel'), parallel_others)]
                        cache[key] = summarize(items, query, args.marketplace)
                        s = cache[key]
                        print(f'{c["number"]:9} {abbr:4} {s["count"]:3} listings'
                              + (f'  median {s["median"]} {s["currency"]}' if s['count'] else ''))
                    except (urllib.error.URLError, TimeoutError) as e:
                        failures += 1
                        print(f'{c["number"]:9} {abbr:4} FAILED: {e}', file=sys.stderr)
                        cache[key] = None
                    time.sleep(args.delay)
                if cache[key] is not None:
                    if cache[key]['count']:
                        cards_out[c['id']] = cache[key]  # only cards with listings are published
                elif c['id'] in previous:
                    cards_out[c['id']] = previous[c['id']]  # keep the last good price on a failed lookup

    if args.dry_run:
        return
    out = {
        'version': 1,
        'source': 'ebay-browse',
        'marketplace': args.marketplace,
        'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'excludedRarities': sorted(excluded),
        'cards': cards_out,
    }
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'Wrote {out_path.name}: {len(cards_out)} cards with listings, {len(cache)} searches, {failures} failed.')


if __name__ == '__main__':
    main()
