// Связка сайта с сервером: подменяет платформенный window.claude (db / user / downloads).
(function () {
  const BASE = String(window.AMPER_API || '').replace(/\/$/, '');
  const ls = { get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const frz = o => { if (o && typeof o === 'object') { Object.values(o).forEach(frz); Object.freeze(o); } return o; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // «Сервер просыпается»: бесплатный Render засыпает, первый запрос может идти около минуты
  let wake = null, pending = 0;
  const note = on => {
    if (on && !wake) { wake = document.createElement('div'); wake.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:9999;background:#1c1f29;color:#fff;border:1px solid #ff8a3d;border-radius:99px;padding:8px 16px;font:500 13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)'; wake.textContent = 'Сервер просыпается, подождите немного…'; (document.body || document.documentElement).appendChild(wake); }
    if (!on && wake) { wake.remove(); wake = null; }
  };
  const headers = extra => { const h = { ...(extra || {}) }; const u = ls.get('amper_u'), a = ls.get('amper_a'); if (u) h['X-Uid'] = u; if (a) h['X-Admin'] = a; return h; };
  async function req(path, opt = {}) {
    let timer = setTimeout(() => note(true), 4000); pending++;
    try {
      for (let i = 0; ; i++) {
        let r;
        try { r = await fetch(BASE + path, { ...opt, headers: headers(opt.headers) }); }
        catch (e) { if (i >= 14) throw e; await sleep(5000); continue; }
        if ([502, 503, 504].includes(r.status) && i < 14) { await sleep(5000); continue; }
        const b = await r.json().catch(() => ({}));
        if (!r.ok) { const e = new Error(b.error || r.status); e.status = r.status; throw e; }
        return b;
      }
    } finally { clearTimeout(timer); if (--pending <= 0) note(false); }
  }
  const body = d => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  const q = p => '/api/doc?path=' + encodeURIComponent(p);
  const doc = path => ({
    id: path.split('/').pop(), path,
    async get() { const r = await req(q(path)); return { exists: !!r.exists, data: () => frz(JSON.parse(JSON.stringify(r.data))) }; },
    async set(d) { await req(q(path), { method: 'PUT', ...body(d) }); },
    async update(d) { await req(q(path), { method: 'PATCH', ...body(d) }); },
    async delete() { await req(q(path), { method: 'DELETE' }); }
  });
  const snapOf = j => { const docs = j.docs.map(d => ({ id: d.id, exists: true, data: () => frz(JSON.parse(JSON.stringify(d.data))) })); return { docs, size: docs.length, empty: !docs.length }; };
  const db = {
    doc,
    collection: col => ({
      doc: id => doc(col + '/' + id),
      onSnapshot(next, err) {
        let es, closed = false;
        const open = () => {
          if (closed) return;
          es = new EventSource(BASE + '/api/watch?col=' + encodeURIComponent(col) + '&u=' + encodeURIComponent(ls.get('amper_u')) + '&a=' + encodeURIComponent(ls.get('amper_a')));
          es.onmessage = e => { try { next(snapOf(JSON.parse(e.data))); } catch (x) { console.error(x); } };
          es.onerror = () => { if (es.readyState === 2) { es.close(); if (!closed) setTimeout(open, 8000); } };
        };
        // сначала убеждаемся, что личный id уже получен
        getMe().then(open, open);
        return () => { closed = true; if (es) es.close(); };
      }
    })
  };
  let me = null;
  async function getMe() {
    if (me) return me;
    me = (async () => {
      let r = await req('/api/me');
      if (r.uid) { ls.set('amper_u', r.uid); r = await req('/api/me'); }
      return { uid: ls.get('amper_u').split('.')[0], admin: !!r.admin };
    })();
    me.catch(() => { me = null; });
    return me;
  }
  const user = { id: async () => (await getMe()).uid, isOwner: async () => (await getMe()).admin, canEdit: async () => (await getMe()).admin };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'file';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  };
  window.claude = { use: async n => { if (n === 'db') return db; if (n === 'user') return user; if (n === 'downloads') return downloads; throw new Error('Недоступно в этой версии: ' + n); } };
})();
