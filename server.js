const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q, tx, init } = require('./db');
const spin = require('./spin');

const PORT = process.env.PORT || 3000;
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[warn] JWT_SECRET absent: secret aléatoire (les sessions sautent à chaque redémarrage).');
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const int = v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
const isInt = v => Number.isSafeInteger(v);
const str = (v, min, max, field) => {
  const s = String(v == null ? '' : v).trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${field} invalide`);
  return s;
};
const phone = v => String(v || '').replace(/[\s\-().]/g, '');
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const safeUrl = s => { try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };

async function getSettings(c) {
  const { rows } = await (c || { query: q }).query('select key,value from settings');
  const s = {}; rows.forEach(r => (s[r.key] = r.value));
  return s;
}

/* ---------- auth ---------- */
const sign = u => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '30d' });
const auth = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) throw new HttpError(401, 'Connexion requise');
  let p;
  try { p = jwt.verify(t, JWT_SECRET); } catch { throw new HttpError(401, 'Session expirée, reconnectez-vous'); }
  const { rows } = await q('select id,pseudo,role,balance,spin_diamonds,spin_packs,spin_free,whatsapp from users where id=$1', [p.sub]);
  if (!rows[0]) throw new HttpError(401, 'Compte introuvable');
  req.user = rows[0];
  next();
});
const adminOnly = [auth, (req, res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Admin uniquement')))];

const publicUser = u => ({
  id: u.id, pseudo: u.pseudo, role: u.role, balance: u.balance,
  spinDiamonds: u.spin_diamonds, spinFree: u.spin_free, spinPacks: u.spin_packs, whatsapp: u.whatsapp,
});

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de tentatives, réessayez plus tard' } });
app.use('/api', apiLimiter);

app.get('/healthz', wrap(async (req, res) => { await q('select 1'); res.json({ ok: true }); }));

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const pseudo = str(req.body.pseudo, 3, 24, 'Pseudo');
  if (!/^[A-Za-z0-9_.-]+$/.test(pseudo)) throw new HttpError(400, 'Pseudo: lettres, chiffres, _ . - seulement');
  const pw = String(req.body.password || '');
  if (pw.length < 6 || pw.length > 72) throw new HttpError(400, 'Mot de passe: 6 à 72 caractères');
  const hash = await bcrypt.hash(pw, 11);
  let u;
  try {
    u = (await q('insert into users(pseudo,pass_hash) values($1,$2) returning *', [pseudo, hash])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Ce pseudo est déjà pris');
    throw e;
  }
  res.status(201).json({ token: sign(u), user: publicUser(u) });
}));

const DUMMY = bcrypt.hashSync('dummy-password', 11);
app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const pseudo = String(req.body.pseudo || '').trim();
  const u = (await q('select * from users where lower(pseudo)=lower($1)', [pseudo])).rows[0];
  const ok = await bcrypt.compare(String(req.body.password || ''), u ? u.pass_hash : DUMMY);
  if (!u || !ok) throw new HttpError(401, 'Pseudo ou mot de passe incorrect');
  res.json({ token: sign(u), user: publicUser(u) });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.patch('/api/me', auth, wrap(async (req, res) => {
  const sets = [], vals = [];
  if (req.body.pseudo !== undefined) {
    const p = str(req.body.pseudo, 3, 24, 'Pseudo');
    if (!/^[A-Za-z0-9_.-]+$/.test(p)) throw new HttpError(400, 'Pseudo invalide');
    vals.push(p); sets.push(`pseudo=$${vals.length}`);
  }
  if (req.body.whatsapp !== undefined) {
    const w = phone(req.body.whatsapp);
    if (w && !PHONE_RE.test(w)) throw new HttpError(400, 'Numéro WhatsApp invalide');
    vals.push(w); sets.push(`whatsapp=$${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Rien à modifier');
  vals.push(req.user.id);
  try {
    const u = (await q(`update users set ${sets.join(',')} where id=$${vals.length} returning *`, vals)).rows[0];
    res.json({ user: publicUser(u) });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Ce pseudo est déjà pris');
    throw e;
  }
}));

/* ---------- guide (vidéo d'accueil + lien chaîne) ---------- */
app.get('/api/guide', wrap(async (req, res) => {
  const s = await getSettings();
  const v = (await q('select extract(epoch from updated_at)::bigint as t from guide_video where id=1')).rows[0];
  res.set('Cache-Control', 'no-store');
  res.json({
    channel: s.guide_channel || '',
    video: v ? `${req.protocol}://${req.get('host')}/api/guide/video?v=${v.t}` : '',
  });
}));

app.get('/api/guide/video', wrap(async (req, res) => {
  const m = (await q('select mime, octet_length(data)::bigint as size from guide_video where id=1')).rows[0];
  if (!m) throw new HttpError(404, 'Aucune vidéo');
  const size = Number(m.size);
  let start = 0, end = size - 1, partial = false;
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (r && (r[1] || r[2])) {
    partial = true;
    if (r[1] === '') start = Math.max(0, size - Number(r[2]));
    else { start = Number(r[1]); if (r[2] !== '') end = Math.min(end, Number(r[2])); }
    end = Math.min(end, start + 4 * 1024 * 1024 - 1);
    if (start > end || start >= size) { res.status(416).set('Content-Range', `bytes */${size}`).end(); return; }
  }
  const len = end - start + 1;
  const { rows } = await q('select substring(data from $1 for $2) as chunk from guide_video where id=1', [start + 1, len]);
  res.status(partial ? 206 : 200).set({
    'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Content-Length': rows[0].chunk.length,
    'Cache-Control': 'public, max-age=300',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  res.end(rows[0].chunk);
}));

app.post('/api/admin/guide', adminOnly, wrap(async (req, res) => {
  const raw = String(req.body.channel || '').trim();
  const url = raw ? safeUrl(raw) : '';
  if (raw && !url) throw new HttpError(400, 'Lien de chaîne invalide (http/https)');
  await q("insert into settings(key,value) values('guide_channel',$1) on conflict (key) do update set value=excluded.value", [url]);
  res.json({ ok: true, channel: url });
}));

app.put('/api/admin/guide-video', adminOnly,
  express.raw({ type: ['video/mp4', 'video/webm'], limit: '50mb' }),
  wrap(async (req, res) => {
    const b = req.body;
    if (!Buffer.isBuffer(b) || !b.length) throw new HttpError(415, 'Envoyez un fichier MP4 ou WebM (50 Mo max)');
    const mime = req.headers['content-type'].split(';')[0];
    const isMp4 = b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp';
    const isWebm = b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    if ((mime === 'video/mp4' && !isMp4) || (mime === 'video/webm' && !isWebm)) throw new HttpError(400, 'Fichier vidéo invalide');
    await q(`insert into guide_video(id,mime,data,updated_at) values(1,$1,$2,now())
             on conflict (id) do update set mime=excluded.mime, data=excluded.data, updated_at=now()`, [mime, b]);
    res.json({ ok: true, bytes: b.length });
  }));
app.delete('/api/admin/guide-video', adminOnly, wrap(async (req, res) => { await q('delete from guide_video where id=1'); res.json({ ok: true }); }));

/* ---------- catalogue ---------- */
app.get('/api/catalog', wrap(async (req, res) => {
  const s = await getSettings();
  const games = (await q('select * from games order by sort,id')).rows;
  const packs = (await q('select * from packs order by sort,id')).rows;
  const ann = (await q('select * from announcements order by id desc')).rows;
  res.json({
    settings: { name: s.name, whatsapp: s.whatsapp, moncash: s.moncash, natcash: s.natcash, spinPrice: Number(s.spin_price) },
    games: games.map(g => ({
      id: g.id, name: g.name, unit: g.unit, color: g.color,
      packs: packs.filter(p => p.game_id === g.id).map(p => ({ id: p.id, qty: p.qty, price: p.price, label: p.label, kind: p.kind })),
    })),
    announcements: ann.map(a => ({ id: a.id, title: a.title, price: a.price, description: a.description, whatsapp: a.whatsapp, img: a.img })),
  });
}));

/* ---------- wallet / paiements ---------- */
app.get('/api/payments', auth, wrap(async (req, res) => {
  const { rows } = await q('select id,method,amount,code,status,credited,created_at from payments where user_id=$1 order by id desc limit 200', [req.user.id]);
  res.json({ payments: rows });
}));

app.post('/api/payments', auth, wrap(async (req, res) => {
  const method = req.body.method === 'natcash' ? 'natcash' : 'moncash';
  const amount = int(req.body.amount);
  if (!isInt(amount) || amount < 50 || amount > 1000000) throw new HttpError(400, 'Montant invalide (50 à 1 000 000 HTG)');
  const code = str(req.body.code, 5, 40, 'Code de transaction');
  const pend = (await q("select count(*)::int n from payments where user_id=$1 and status='wait'", [req.user.id])).rows[0].n;
  if (pend >= 10) throw new HttpError(429, 'Trop de demandes en attente');
  try {
    const p = (await q('insert into payments(user_id,method,amount,code) values($1,$2,$3,$4) returning id,method,amount,code,status,credited,created_at',
      [req.user.id, method, amount, code])).rows[0];
    res.status(201).json({ payment: p });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Cette référence a déjà été utilisée');
    throw e;
  }
}));

app.get('/api/admin/payments', adminOnly, wrap(async (req, res) => {
  const st = ['wait', 'ok', 'no'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await q(`select p.*, u.pseudo from payments p join users u on u.id=p.user_id
    where ($1::text is null or p.status=$1) order by p.id desc limit 300`, [st]);
  res.json({ payments: rows });
}));
app.post('/api/admin/payments/:id/approve', adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id), got = int(req.body.received);
  await tx(async c => {
    const p = (await c.query('select * from payments where id=$1 for update', [id])).rows[0];
    if (!p) throw new HttpError(404, 'Paiement introuvable');
    if (p.status !== 'wait') throw new HttpError(409, 'Déjà traité');
    if (!isInt(got) || got < 1 || got > p.amount) throw new HttpError(400, `Montant reçu invalide (1 à ${p.amount})`);
    await c.query("update payments set status='ok', credited=$2, decided_at=now() where id=$1", [id, got]);
    await c.query('update users set balance=balance+$2 where id=$1', [p.user_id, got]);
  });
  res.json({ ok: true });
}));
app.post('/api/admin/payments/:id/reject', adminOnly, wrap(async (req, res) => {
  const r = await q("update payments set status='no', decided_at=now() where id=$1 and status='wait'", [Number(req.params.id)]);
  if (!r.rowCount) throw new HttpError(409, 'Paiement introuvable ou déjà traité');
  res.json({ ok: true });
}));

/* ---------- commandes ---------- */
const orderOut = o => ({
  id: o.id, game: o.game, unit: o.unit, pack: o.pack_label, qty: o.qty, price: o.price,
  playerId: o.player_id, playerName: o.player_name, whatsapp: o.whatsapp, status: o.status, createdAt: o.created_at,
  ...(o.pseudo ? { pseudo: o.pseudo } : {}),
});
app.get('/api/orders', auth, wrap(async (req, res) => {
  const { rows } = await q('select * from orders where user_id=$1 order by id desc limit 200', [req.user.id]);
  res.json({ orders: rows.map(orderOut) });
}));
app.post('/api/orders', auth, wrap(async (req, res) => {
  const packId = int(req.body.packId);
  if (!isInt(packId)) throw new HttpError(400, 'Pack invalide');
  const playerId = String(req.body.playerId || '').trim();
  if (!/^[0-9]{5,20}$/.test(playerId)) throw new HttpError(400, 'ID joueur invalide (5 à 20 chiffres)');
  const playerName = str(req.body.playerName, 2, 40, 'Nom du compte');
  const wa = phone(req.body.whatsapp);
  if (!PHONE_RE.test(wa)) throw new HttpError(400, 'Numéro WhatsApp invalide');
  const out = await tx(async c => {
    const p = (await c.query('select p.*, g.name gname, g.unit gunit from packs p join games g on g.id=p.game_id where p.id=$1', [packId])).rows[0];
    if (!p) throw new HttpError(404, 'Pack introuvable');
    if (!(p.price > 0)) throw new HttpError(409, 'Prix du pack à confirmer par l’admin');
    const pay = await c.query('update users set balance=balance-$2, whatsapp=$3 where id=$1 and balance>=$2 returning balance', [req.user.id, p.price, wa]);
    if (!pay.rowCount) throw new HttpError(402, 'Solde insuffisant : rechargez votre wallet');
    const o = (await c.query(`insert into orders(user_id,game,unit,pack_label,qty,price,player_id,player_name,whatsapp)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [req.user.id, p.gname, p.label ? '' : p.gunit, p.label, p.qty, p.price, playerId, playerName, wa])).rows[0];
    return { order: orderOut(o), balance: pay.rows[0].balance };
  });
  res.status(201).json(out);
}));

app.get('/api/admin/orders', adminOnly, wrap(async (req, res) => {
  const st = ['wait', 'verified', 'liv', 'no'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await q(`select o.*, u.pseudo from orders o join users u on u.id=o.user_id
    where ($1::text is null or o.status=$1) order by o.id desc limit 300`, [st]);
  res.json({ orders: rows.map(orderOut) });
}));
const NEXT = { wait: ['verified', 'liv', 'no'], verified: ['liv', 'no'] };
app.post('/api/admin/orders/:id/status', adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id), to = String(req.body.status || '');
  await tx(async c => {
    const o = (await c.query('select * from orders where id=$1 for update', [id])).rows[0];
    if (!o) throw new HttpError(404, 'Commande introuvable');
    if (!(NEXT[o.status] || []).includes(to)) throw new HttpError(409, `Transition ${o.status} → ${to} impossible`);
    await c.query('update orders set status=$2, updated_at=now() where id=$1', [id, to]);
    if (to === 'no') await c.query('update users set balance=balance+$2 where id=$1', [o.user_id, o.price]); // remboursement (une seule fois)
  });
  res.json({ ok: true });
}));

/* ---------- spin ---------- */
app.get('/api/spin/config', wrap(async (req, res) => {
  const s = await getSettings();
  res.json(spin.publicConfig(Number(s.spin_price)));
}));

app.post('/api/spin', auth, wrap(async (req, res) => {
  const times = int(req.body.times) === 5 ? 5 : 1;
  const out = await tx(async c => {
    const price = Number((await getSettings(c)).spin_price);
    const u = (await c.query('select * from users where id=$1 for update', [req.user.id])).rows[0];
    let free = u.spin_free, bal = u.balance, packs = u.spin_packs;
    if (times === 1 && free > 0) free -= 1;
    else {
      const cost = price * times;
      if (bal < cost) throw new HttpError(402, 'Solde insuffisant — rechargez votre wallet');
      bal -= cost;
    }
    const third = times === 5 && packs >= 2;
    const picks = [];
    for (let i = 0; i < times; i++) picks.push(spin.rollFinal(third && i === 4));
    if (times === 5) packs = third ? 0 : packs + 1;

    const results = [];
    let dia = 0, wins = 0;
    for (const p of picks) {
      let rewardId = null;
      if (p.t !== 'lose') {
        wins++; dia += p.v;
        rewardId = (await c.query('insert into spin_rewards(user_id,name,diamonds) values($1,$2,$3) returning id', [u.id, p.nm, p.v])).rows[0].id;
      }
      results.push({ slot: p.n, name: p.nm, type: p.t, diamonds: p.v, rewardId });
    }
    const nu = (await c.query(`update users set balance=$2, spin_free=$3, spin_packs=$4,
      spin_diamonds=spin_diamonds+$5, spins=spins+$6, wins=wins+$7 where id=$1 returning *`,
      [u.id, bal, free, packs, dia, times, wins])).rows[0];
    return { results, user: publicUser(nu), guaranteed: third };
  });
  res.json(out);
}));

app.get('/api/spin/rewards', auth, wrap(async (req, res) => {
  const { rows } = await q('select id,name,diamonds,status,created_at,claimed_at,delivered_at from spin_rewards where user_id=$1 order by id desc limit 100', [req.user.id]);
  res.json({ rewards: rows });
}));
app.post('/api/spin/rewards/:id/claim', auth, wrap(async (req, res) => {
  const uid = String(req.body.uid || '').trim();
  if (!/^[0-9]{5,20}$/.test(uid)) throw new HttpError(400, 'ID Free Fire invalide');
  const pseudo = str(req.body.pseudo, 2, 40, 'Pseudo Free Fire');
  const wa = phone(req.body.whatsapp);
  if (!PHONE_RE.test(wa)) throw new HttpError(400, 'WhatsApp invalide');
  const r = await q(`update spin_rewards set status='claimed', claim_uid=$3, claim_pseudo=$4, claim_wa=$5, claimed_at=now()
    where id=$1 and user_id=$2 and status='unclaimed' returning id,name,status`, [Number(req.params.id), req.user.id, uid, pseudo, wa]);
  if (!r.rowCount) throw new HttpError(409, 'Récompense introuvable ou déjà réclamée');
  res.json({ reward: r.rows[0] });
}));
app.get('/api/admin/rewards', adminOnly, wrap(async (req, res) => {
  const { rows } = await q(`select r.*, u.pseudo from spin_rewards r join users u on u.id=r.user_id
    where r.status in ('claimed','delivered') order by (r.status='claimed') desc, r.id desc limit 300`);
  res.json({ rewards: rows });
}));
app.post('/api/admin/rewards/:id/deliver', adminOnly, wrap(async (req, res) => {
  const r = await q("update spin_rewards set status='delivered', delivered_at=now() where id=$1 and status='claimed'", [Number(req.params.id)]);
  if (!r.rowCount) throw new HttpError(409, 'Récompense non réclamée ou déjà livrée');
  res.json({ ok: true });
}));

/* ---------- classement ---------- */
app.get('/api/top', wrap(async (req, res) => {
  const { rows } = await q(`
    with m as (
      select user_id, sum(qty)::bigint d from orders
        where unit='Diamants' and status<>'no' and created_at >= date_trunc('month', now()) group by user_id
      union all
      select user_id, sum(diamonds)::bigint from spin_rewards
        where diamonds>0 and created_at >= date_trunc('month', now()) group by user_id)
    select u.pseudo, sum(m.d)::int as diamonds from m join users u on u.id=m.user_id
    group by u.id, u.pseudo having sum(m.d) > 0 order by diamonds desc limit 100`);
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ top: rows });
}));

/* ---------- admin: réglages, catalogue, annonces, stats ---------- */
app.get('/api/admin/stats', adminOnly, wrap(async (req, res) => {
  const r = (await q(`select
    (select count(*) from users)::int users,
    (select count(*) from payments where status='wait')::int pending_payments,
    (select count(*) from orders where status in ('wait','verified'))::int open_orders,
    (select count(*) from spin_rewards where status='claimed')::int rewards_to_deliver,
    (select coalesce(sum(credited),0) from payments where status='ok')::bigint credited_total`)).rows[0];
  res.json(r);
}));
app.get('/api/admin/users', adminOnly, wrap(async (req, res) => {
  const { rows } = await q('select id,pseudo,role,balance,spin_diamonds,spins,wins,created_at from users order by id desc limit 500');
  res.json({ users: rows });
}));
app.get('/api/admin/settings', adminOnly, wrap(async (req, res) => res.json({ settings: await getSettings() })));
app.put('/api/admin/settings', adminOnly, wrap(async (req, res) => {
  const b = req.body, upd = {};
  if (b.name !== undefined) upd.name = str(b.name, 1, 40, 'Nom');
  if (b.moncash !== undefined) upd.moncash = str(b.moncash, 0, 30, 'Numéro MonCash');
  if (b.natcash !== undefined) upd.natcash = str(b.natcash, 0, 30, 'Numéro NatCash');
  if (b.whatsapp !== undefined) { const w = phone(b.whatsapp); if (w && !PHONE_RE.test(w)) throw new HttpError(400, 'WhatsApp invalide'); upd.whatsapp = w; }
  if (b.spinPrice !== undefined) {
    const n = int(b.spinPrice);
    if (!isInt(n) || n < 0 || n > 100000) throw new HttpError(400, 'Prix du spin invalide');
    upd.spin_price = String(n);
  }
  for (const [k, v] of Object.entries(upd)) {
    await q('insert into settings(key,value) values($1,$2) on conflict (key) do update set value=excluded.value', [k, v]);
  }
  res.json({ settings: await getSettings() });
}));

app.post('/api/admin/games', adminOnly, wrap(async (req, res) => {
  const name = str(req.body.name, 1, 40, 'Nom du jeu'), unit = str(req.body.unit || 'Packs', 1, 20, 'Unité');
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#333333';
  const g = (await q('insert into games(name,unit,color,sort) values($1,$2,$3,(select coalesce(max(sort),0)+1 from games)) returning *', [name, unit, color])).rows[0];
  res.status(201).json({ game: g });
}));
app.delete('/api/admin/games/:id', adminOnly, wrap(async (req, res) => { await q('delete from games where id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));
app.post('/api/admin/games/:id/packs', adminOnly, wrap(async (req, res) => {
  const qty = int(req.body.qty), price = int(req.body.price);
  if (!isInt(qty) || qty < 1 || !isInt(price) || price < 0) throw new HttpError(400, 'Quantité et prix requis');
  const label = str(req.body.label || '', 0, 60, 'Libellé');
  const p = (await q(`insert into packs(game_id,qty,price,label,sort)
    select id,$2,$3,$4,(select coalesce(max(sort),0)+1 from packs where game_id=$1) from games where id=$1 returning *`,
    [Number(req.params.id), qty, price, label])).rows[0];
  if (!p) throw new HttpError(404, 'Jeu introuvable');
  res.status(201).json({ pack: p });
}));
app.patch('/api/admin/packs/:id', adminOnly, wrap(async (req, res) => {
  const sets = [], vals = [];
  if (req.body.price !== undefined) { const n = int(req.body.price); if (!isInt(n) || n < 0) throw new HttpError(400, 'Prix invalide'); vals.push(n); sets.push(`price=$${vals.length}`); }
  if (req.body.qty !== undefined) { const n = int(req.body.qty); if (!isInt(n) || n < 1) throw new HttpError(400, 'Quantité invalide'); vals.push(n); sets.push(`qty=$${vals.length}`); }
  if (!sets.length) throw new HttpError(400, 'Rien à modifier');
  vals.push(Number(req.params.id));
  const r = await q(`update packs set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
  if (!r.rowCount) throw new HttpError(404, 'Pack introuvable');
  res.json({ pack: r.rows[0] });
}));
app.delete('/api/admin/packs/:id', adminOnly, wrap(async (req, res) => { await q('delete from packs where id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));

app.post('/api/admin/announcements', adminOnly, wrap(async (req, res) => {
  const title = str(req.body.title, 1, 80, 'Titre'), price = int(req.body.price);
  if (!isInt(price) || price < 1) throw new HttpError(400, 'Prix requis');
  const img = String(req.body.img || '');
  if (img && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 800000)) throw new HttpError(400, 'Image invalide (png/jpeg/webp, ~600 Ko max)');
  const wa = phone(req.body.whatsapp);
  if (wa && !PHONE_RE.test(wa)) throw new HttpError(400, 'WhatsApp invalide');
  const a = (await q('insert into announcements(title,price,description,whatsapp,img) values($1,$2,$3,$4,$5) returning *',
    [title, price, str(req.body.description || '', 0, 500, 'Description'), wa, img])).rows[0];
  res.status(201).json({ announcement: a });
}));
app.delete('/api/admin/announcements/:id', adminOnly, wrap(async (req, res) => { await q('delete from announcements where id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));

/* ---------- front + erreurs ---------- */
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable' }));
app.use((err, req, res, next) => { // eslint-disable-line
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Fichier trop volumineux' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

init().then(() => app.listen(PORT, '0.0.0.0', () => console.log('ZHUO FAN HT backend sur le port', PORT)))
  .catch(e => { console.error('Init échouée:', e); process.exit(1); });
