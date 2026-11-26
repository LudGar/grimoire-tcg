/* Sign-in and collection sync for Grimoire, backed by Supabase.
 *
 * The browser copy (localStorage) stays the working copy, so the page keeps
 * working signed out or offline. One sync is one call to the database function
 * sync_collection: it sends the cards changed here since the last sync, the
 * server applies them in one transaction and returns the whole collection. So a
 * card changed here wins; everything else comes from the server, including
 * changes and removals made on other devices.
 *
 * The key below is the publishable key. It is meant to be public: access is
 * enforced by the database's row level security.
 */
(function (root) {
  'use strict';

  var API = 'https://lzdkfxdeaikgnylfrkzr.supabase.co';
  var KEY = 'sb_publishable_YNAUvrkRJuH3m2WIeOVGQg_ovTy-EnW';
  var AUTH_KEY = 'grimoire-auth-v1';
  var RPC = '/rest/v1/rpc/sync_collection';
  var RESET_GUARD = 10;

  // ---------- pure merge logic ----------
  // A "flat" collection maps "systemId\ncardId" to {qty, addedAt, ...}.
  function flatten(collector) {
    var out = {};
    Object.keys(collector || {}).forEach(function (sys) {
      var bucket = collector[sys] || {};
      Object.keys(bucket).forEach(function (card) {
        var e = bucket[card];
        if (!e || !e.owned) return;
        out[sys + '\n' + card] = Object.assign({}, e, { owned: true, qty: Math.max(1, Math.floor(e.qty || 1)) });
      });
    });
    return out;
  }
  function unflatten(flat) {
    var out = {};
    Object.keys(flat).forEach(function (k) {
      var p = k.split('\n');
      (out[p[0]] = out[p[0]] || {})[p[1]] = flat[k];
    });
    return out;
  }
  function qtyOf(flat, k) { return flat && flat[k] ? flat[k].qty : 0; }
  function keysOf() {
    var seen = {};
    for (var i = 0; i < arguments.length; i++) Object.keys(arguments[i] || {}).forEach(function (k) { seen[k] = 1; });
    return Object.keys(seen);
  }
  // Used for edits made while a sync is running: what changed here wins, the
  // rest comes from the server. (base === null keeps the larger quantity.)
  function merge(base, local, remote) {
    var out = {};
    keysOf(base, local, remote).forEach(function (k) {
      var l = qtyOf(local, k), r = qtyOf(remote, k), pick;
      if (base === null) pick = l >= r ? local[k] : remote[k];
      else pick = l !== qtyOf(base, k) ? local[k] : remote[k];
      if (pick) out[k] = pick;
    });
    return out;
  }
  // What differs when going from `remote` to `wanted`.
  function changes(wanted, remote) {
    var upserts = [], deletes = [];
    keysOf(wanted, remote).forEach(function (k) {
      if (!wanted[k]) deletes.push(k);
      else if (qtyOf(wanted, k) !== qtyOf(remote, k)) upserts.push(k);
    });
    return { upserts: upserts, deletes: deletes };
  }
  function quantities(flat) {
    var out = {};
    Object.keys(flat).forEach(function (k) { out[k] = { qty: flat[k].qty }; });
    return out;
  }

  // ---------- session ----------
  function fail(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function getSession() {
    try { return JSON.parse(root.localStorage.getItem(AUTH_KEY)) || null; } catch (e) { return null; }
  }
  function setSession(s) {
    try {
      if (s) root.localStorage.setItem(AUTH_KEY, JSON.stringify(s));
      else root.localStorage.removeItem(AUTH_KEY);
    } catch (e) { throw fail('storage'); }
  }
  async function send(path, init) {
    try { return await root.fetch(API + path, init); } catch (e) { throw fail('offline'); }
  }
  async function auth(path, body, token) {
    var headers = { apikey: KEY, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await send('/auth/v1/' + path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) });
    var data = null;
    try { data = await res.json(); } catch (e) { /* logout has no body */ }
    if (!res.ok) throw fail((data && (data.error_code || data.error)) || ('http_' + res.status), data && (data.msg || data.error_description));
    return data;
  }
  function toSession(d) {
    return {
      access: d.access_token,
      refresh: d.refresh_token,
      expiresAt: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
      user: { id: d.user.id, email: d.user.email }
    };
  }
  // One tab at a time: refresh tokens are single-use and tabs share storage.
  function exclusive(name, fn) {
    var locks = root.navigator && root.navigator.locks;
    return locks ? locks.request(name, fn) : fn();
  }
  async function signIn(email, password) {
    var s = toSession(await auth('token?grant_type=password', { email: email, password: password }));
    setSession(s);
    return s.user;
  }
  async function signOut() {
    var s = getSession();
    setSession(null);
    if (s) { try { await auth('logout?scope=local', {}, s.access); } catch (e) { /* signed out here either way */ } }
  }
  function accessToken() {
    return exclusive('grimoire-auth', async function () {
      var s = getSession();
      if (!s) throw fail('signed_out');
      if (s.expiresAt - Date.now() / 1000 > 60) return s.access;
      try {
        var next = toSession(await auth('token?grant_type=refresh_token', { refresh_token: s.refresh }));
        setSession(next);
        return next.access;
      } catch (e) {
        if (e.code === 'offline' || /^http_5/.test(e.code)) throw e;
        setSession(null);
        throw fail('signed_out');
      }
    });
  }

  // ---------- collection rows ----------
  async function rest(path, init, token) {
    init.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + token }, init.headers || {});
    var res = await send(path, init);
    if (!res.ok) throw fail(res.status === 401 ? 'signed_out' : 'http_' + res.status, await res.text());
    return res;
  }
  // Send `keys` as the server should now hold them (quantity 0 removes) and get
  // the whole collection back. keepLarger never lowers or removes anything.
  async function exchange(local, keys, keepLarger, token) {
    var list = keys.map(function (k) {
      var p = k.split('\n'), e = local[k];
      var row = { game_id: p[0], card_id: p[1], qty: e ? e.qty : 0 };
      if (e && e.addedAt) row.added_at = new Date(e.addedAt).toISOString();
      return row;
    });
    var res = await rest(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: list, keep_larger: keepLarger })
    }, token);
    var data = await res.json();
    var remote = {};
    data.rows.forEach(function (r) { remote[r[0] + '\n' + r[1]] = { owned: true, qty: r[2], addedAt: r[3] }; });
    return { before: data.before, remote: remote };
  }

  // ---------- sync ----------
  // io.read()  -> {collector, sync}      the stored browser copy
  // io.write(collector, sync, previous)  stores both together; must throw if it cannot.
  //            `previous` is set when owned cards are being removed or lowered.
  // io.mergeForeign() -> boolean         the browser holds another account's cards:
  //            true adds them to this account, false replaces them.
  function run(io) {
    return exclusive('grimoire-sync', async function () {
      var token = await accessToken();
      var user = getSession().user;
      var start = io.read();
      var meta = start.sync || null;
      var mine = !!meta && meta.userId === user.id;
      var before = flatten(start.collector);
      var local = before;
      if (meta && !mine && Object.keys(before).length && !io.mergeForeign()) local = {};

      var base = mine ? meta.base : null;
      var diff = changes(local, base || {});
      var answer = await exchange(local, diff.upserts.concat(diff.deletes), base === null, token);
      // An empty server after a sync that held many cards is far more likely a
      // reset database than someone unticking every card: upload again, don't erase.
      if (base && !answer.before && Object.keys(base).length >= RESET_GUARD) {
        diff = changes(local, {});
        answer = await exchange(local, diff.upserts, true, token);
      }
      var remote = answer.remote;

      var current = getSession();
      if (!current || current.user.id !== user.id) throw fail('signed_out');

      // Keep anything the user changed while the requests were running.
      var latest = flatten(io.read().collector);
      var result = merge(before, latest, remote);
      var lost = Object.keys(latest).some(function (k) { return qtyOf(result, k) < latest[k].qty; });
      io.write(unflatten(result), { userId: user.id, base: quantities(remote), at: Date.now() }, lost ? unflatten(latest) : null);

      var waiting = changes(result, remote);
      return {
        collector: unflatten(result),
        uploaded: diff.upserts.length,
        removed: diff.deletes.length,
        pending: waiting.upserts.length + waiting.deletes.length > 0
      };
    });
  }

  var api = {
    user: function () { var s = getSession(); return s ? s.user : null; },
    signIn: signIn,
    signOut: signOut,
    sync: run,
    AUTH_KEY: AUTH_KEY,
    _pure: { flatten: flatten, unflatten: unflatten, merge: merge, changes: changes }
  };
  root.GrimoireSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
