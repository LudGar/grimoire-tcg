/* Sign-in and collection sync for Grimoire, backed by Supabase.
 *
 * The browser copy (localStorage) stays the working copy, so the page keeps
 * working signed out or offline. Syncing is a three-way merge per card between
 *   base   - what the server held after this browser's last sync
 *   local  - this browser now
 *   remote - the server now
 * A card changed here since the last sync wins; otherwise the server's value is
 * taken, so changes and removals made on other devices arrive too.
 *
 * The key below is the publishable key. It is meant to be public: access is
 * enforced by the database's row level security.
 */
(function (root) {
  'use strict';

  var API = 'https://lzdkfxdeaikgnylfrkzr.supabase.co';
  var KEY = 'sb_publishable_YNAUvrkRJuH3m2WIeOVGQg_ovTy-EnW';
  var AUTH_KEY = 'grimoire-auth-v1';
  var TABLE = '/rest/v1/grimoire_collection';
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
  // base === null means "never synced": keep everything from both sides, using
  // the larger quantity (the same copies are usually recorded on both).
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
  // What has to change on the server to go from `remote` to `wanted`.
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
    init = init || {};
    init.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + token }, init.headers || {});
    var res = await send(path, init);
    if (!res.ok) throw fail(res.status === 401 ? 'signed_out' : 'http_' + res.status, await res.text());
    return res;
  }
  async function fetchRemote(token) {
    var out = {}, page = 1000;
    for (var from = 0; ; from += page) {
      var res = await rest(TABLE + '?select=system_id,card_id,qty,added_at&order=system_id,card_id&limit=' + page + '&offset=' + from, {}, token);
      var rows = await res.json();
      rows.forEach(function (r) {
        out[r.system_id + '\n' + r.card_id] = { owned: true, qty: r.qty, addedAt: Date.parse(r.added_at) };
      });
      // An empty page is the only reliable end: the server may cap pages below `page`.
      if (!rows.length) return out;
      page = rows.length;
    }
  }
  async function pushChanges(wanted, diff, userId, token) {
    var now = new Date().toISOString();
    for (var i = 0; i < diff.upserts.length; i += 500) {
      var body = diff.upserts.slice(i, i + 500).map(function (k) {
        var p = k.split('\n');
        return { user_id: userId, system_id: p[0], card_id: p[1], qty: wanted[k].qty,
                 added_at: new Date(wanted[k].addedAt || Date.now()).toISOString(), updated_at: now };
      });
      await rest(TABLE + '?on_conflict=user_id,system_id,card_id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(body)
      }, token);
    }
    var bySystem = {};
    diff.deletes.forEach(function (k) { var p = k.split('\n'); (bySystem[p[0]] = bySystem[p[0]] || []).push(p[1]); });
    for (var sys of Object.keys(bySystem)) {
      for (var j = 0; j < bySystem[sys].length; j += 100) {
        var list = bySystem[sys].slice(j, j + 100).map(function (id) { return '"' + id.replace(/["\\]/g, '\\$&') + '"'; }).join(',');
        await rest(TABLE + '?system_id=eq.' + encodeURIComponent(sys) + '&card_id=in.(' + encodeURIComponent(list) + ')',
          { method: 'DELETE' }, token);
      }
    }
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

      var remote = await fetchRemote(token);
      var base = mine ? meta.base : null;
      // An empty server after a sync that held many cards is far more likely a
      // reset database than someone unticking every card: upload again, don't erase.
      if (base && !Object.keys(remote).length && Object.keys(base).length >= RESET_GUARD) base = null;
      var merged = merge(base, local, remote);
      var diff = changes(merged, remote);
      await pushChanges(merged, diff, user.id, token);

      var current = getSession();
      if (!current || current.user.id !== user.id) throw fail('signed_out');

      // Keep anything the user changed while the requests were running.
      var latest = flatten(io.read().collector);
      var result = merge(before, latest, merged);
      var lost = Object.keys(latest).some(function (k) { return qtyOf(result, k) < latest[k].qty; });
      io.write(unflatten(result), { userId: user.id, base: quantities(merged), at: Date.now() }, lost ? unflatten(latest) : null);

      var rest_ = changes(result, merged);
      return {
        collector: unflatten(result),
        uploaded: diff.upserts.length,
        removed: diff.deletes.length,
        pending: rest_.upserts.length + rest_.deletes.length > 0
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
