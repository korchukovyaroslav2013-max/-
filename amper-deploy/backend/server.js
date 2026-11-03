// «Ампер» — сервер (бэкенд). Фронтенд лежит отдельно (Vercel), сюда он обращается по адресу из config.js.
// Хранит документы (каталог, промокоды, заказы, отзывы, список ожидания), проверяет права,
// рассылает изменения в реальном времени (SSE) и отдаёт заказы в Excel администратору.
const http = require('http'), crypto = require('crypto');
const { makeStore } = require('./store');
const xlsx = require('./xlsx');

const PORT = Number(process.env.PORT) || 3000;
const ORIGINS = (process.env.FRONTEND_ORIGIN || '*').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || (process.env.DATABASE_URL ? '' : 'dev-admin-key');
if (!ADMIN_KEY) { console.error('Задайте переменную ADMIN_KEY (ключ администратора). Без неё сервер не запустится.'); process.exit(1); }
const SECRET = process.env.SECRET || crypto.createHash('sha256').update('amper|' + ADMIN_KEY).digest('hex');
const hmac = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- права ----------
const COLS = new Set(['catalog', 'admin', 'promos', 'orders', 'reviews', 'waitlist']);
const PUBLIC_READ = new Set(['catalog', 'promos', 'reviews']);
const SELF = new Set(['orders', 'reviews', 'waitlist']);
const SELF_READ = new Set(['orders', 'waitlist', 'reviews']);
const parsePath = p => { const s = String(p || '').split('/'); return s.length === 2 && COLS.has(s[0]) && /^[\w.-]{1,80}$/.test(s[1]) ? s : null; };
const canReadDoc = (s, c) => c.admin || PUBLIC_READ.has(s[0]) || (SELF_READ.has(s[0]) && s[1] === c.uid);
const canWriteDoc = (s, c) => c.admin || (SELF.has(s[0]) && s[1] === c.uid);
const canReadCol = (col, c) => c.admin || PUBLIC_READ.has(col);

// ---------- кто пришёл (без cookie: подписанный id и токен админа лежат в localStorage сайта) ----------
function ctx(req, url) {
  const u = String(req.headers['x-uid'] || url.searchParams.get('u') || ''), a = String(req.headers['x-admin'] || url.searchParams.get('a') || '');
  const [uid, sig] = u.split('.');
  const okUid = /^[0-9a-f]{24}$/.test(uid || '') && sig && eq(sig, hmac('uid|' + uid).slice(0, 32));
  return { uid: okUid ? uid : null, admin: !!a && eq(a, hmac('admin|' + ADMIN_KEY)) };
}
const newUid = () => { const uid = crypto.randomBytes(12).toString('hex'); return uid + '.' + hmac('uid|' + uid).slice(0, 32); };

// ---------- попытки входа ----------
const tries = new Map();
const tooMany = ip => { const n = Date.now(), r = (tries.get(ip) || []).filter(t => n - t < 60000); tries.set(ip, r); return r.length >= 5; };

// ---------- HTTP-помощники ----------
const cors = (req, res) => {
  const o = String(req.headers.origin || '').replace(/\/$/, '');
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : ORIGINS.includes(o) ? o : ORIGINS[0] || '');
  res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Uid, X-Admin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, DELETE, POST, OPTIONS'); res.setHeader('Access-Control-Max-Age', '86400');
};
const json = (res, st, o) => { res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const readBody = (req, limit = 12e6) => new Promise((ok, no) => { let n = 0; const b = []; req.on('data', c => { n += c.length; if (n > limit) { no(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); } else b.push(c); }); req.on('end', () => ok(Buffer.concat(b).toString('utf8'))); req.on('error', no); });

(async () => {
  const store = await makeStore();
  const subs = new Set();
  const snapshot = async col => ({ docs: (await store.col(col)).filter(r => !r.path.slice(col.length + 1).includes('/')).map(r => ({ id: r.path.slice(col.length + 1), data: JSON.parse(r.json) })) });
  const notify = async col => { if (![...subs].some(s => s.col === col)) return; const m = 'data: ' + JSON.stringify(await snapshot(col)) + '\n\n'; for (const s of subs) if (s.col === col) s.res.write(m); };

  const fmtDate = ms => new Date(ms).toLocaleString('ru-RU', { timeZone: process.env.TZ_NAME || 'Asia/Bishkek', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ST = { new: 'Новый', ok: 'Подтверждён', no: 'Отменён' };
  async function ordersXlsx() {
    const all = (await snapshot('orders')).docs.flatMap(d => d.data.list || []).sort((a, b) => a.d - b.d);
    const A = [['Номер', 'Дата', 'Статус', 'Имя', 'Телефон', 'Промокод', 'Скидка, $', 'Сумма, $', 'Товаров, шт', 'Получение', 'Адрес']];
    const B = [['Номер заказа', 'Дата', 'Статус', 'Покупатель', 'Телефон', 'Товар', 'Кол-во', 'Цена, $', 'Сумма, $']];
    for (const o of all) {
      const d = fmtDate(o.d), st = ST[o.st] || o.st;
      A.push([o.id, d, st, o.name || '', o.phone || '', o.promo || '', o.disc || 0, o.sum, o.items.reduce((a, i) => a + i.q, 0), o.del === 'delivery' ? 'Доставка' : 'Самовывоз', o.addr || '']);
      for (const i of o.items) B.push([o.id, d, st, o.name || '', o.phone || '', i.n, i.q, i.pr, Math.round(i.pr * i.q * 100) / 100]);
    }
    return Buffer.from(xlsx.book([{ name: 'Заказы', rows: A, widths: [10, 17, 14, 18, 18, 12, 10, 12, 12, 13, 30] }, { name: 'Товары в заказах', rows: B, widths: [12, 17, 14, 18, 18, 34, 8, 10, 12] }]));
  }

  async function api(req, res, url) {
    const p = url.pathname, c = ctx(req, url);
    if (p === '/api/health') return json(res, 200, { ok: true, store: store.kind });
    if (p === '/api/me') return json(res, 200, c.uid ? { uid: null, admin: c.admin } : { uid: newUid(), admin: false });
    if (p === '/api/admin-login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (tooMany(ip)) return json(res, 429, { error: 'Слишком много попыток, подождите минуту' });
      let b; try { b = JSON.parse(await readBody(req, 1e4)); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
      tries.get(ip).push(Date.now());
      if (!b || !eq(String(b.key || ''), ADMIN_KEY)) return json(res, 403, { error: 'Неверный ключ' });
      return json(res, 200, { token: hmac('admin|' + ADMIN_KEY) });
    }
    if (p === '/api/orders.xlsx') {
      if (!c.admin) return json(res, 403, { error: 'Нет доступа' });
      const buf = await ordersXlsx();
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="orders.xlsx"', 'Cache-Control': 'no-store' }); return res.end(buf);
    }
    if (p === '/api/watch') {
      const col = url.searchParams.get('col');
      if (!COLS.has(col)) return json(res, 404, { error: 'Нет такой коллекции' });
      if (!canReadCol(col, c)) return json(res, 403, { error: 'Нет доступа' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\ndata: ' + JSON.stringify(await snapshot(col)) + '\n\n');
      const s = { col, res }; subs.add(s);
      const hb = setInterval(() => res.write(': hb\n\n'), 20000);
      req.on('close', () => { clearInterval(hb); subs.delete(s); });
      return;
    }
    if (p === '/api/doc') {
      const s = parsePath(url.searchParams.get('path'));
      if (!s) return json(res, 400, { error: 'Неверный путь' });
      const key = s.join('/');
      if (req.method === 'GET') {
        if (!canReadDoc(s, c)) return json(res, 403, { error: 'Нет доступа' });
        const r = await store.get(key); return json(res, 200, r ? { exists: true, data: JSON.parse(r) } : { exists: false });
      }
      if (!canWriteDoc(s, c)) return json(res, 403, { error: 'Нет доступа' });
      if (req.method === 'DELETE') await store.del(key);
      else if (req.method === 'PUT' || req.method === 'PATCH') {
        let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Нужен объект' });
        if (req.method === 'PATCH') { const r = await store.get(key); body = { ...(r ? JSON.parse(r) : {}), ...body }; }
        await store.set(key, JSON.stringify(body));
      } else return json(res, 405, { error: 'Метод не поддерживается' });
      notify(s[0]).catch(() => {});
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Такого адреса нет' });
  }

  http.createServer(async (req, res) => {
    try {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Ампер: сервер работает'); }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      json(res, 404, { error: 'Такого адреса нет' });
    } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: e.message }); else res.end(); }
  }).listen(PORT, () => console.log(`Ампер: сервер на порту ${PORT}, хранилище: ${store.kind}`));
})();
