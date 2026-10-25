const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const url = process.env.DATABASE_URL || '';
const local = /localhost|127\.0\.0\.1/.test(url) || process.env.DATABASE_SSL === 'false';
const pool = new Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 10,
});

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    try { await c.query('rollback'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

const SCHEMA = `
create table if not exists users(
  id serial primary key,
  pseudo text not null,
  pass_hash text not null,
  role text not null default 'user' check (role in ('user','admin')),
  balance integer not null default 0 check (balance >= 0),
  spin_diamonds integer not null default 0,
  spin_free integer not null default 0,
  spin_packs integer not null default 0,
  spins integer not null default 0,
  wins integer not null default 0,
  whatsapp text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists users_pseudo_lower on users (lower(pseudo));

create table if not exists settings(key text primary key, value text not null default '');

create table if not exists guide_video(
  id integer primary key check (id = 1),
  mime text not null,
  data bytea not null,
  updated_at timestamptz not null default now()
);

create table if not exists games(
  id serial primary key,
  name text not null,
  unit text not null default 'Packs',
  color text not null default '#333333',
  sort integer not null default 0
);
create table if not exists packs(
  id serial primary key,
  game_id integer not null references games(id) on delete cascade,
  qty integer not null default 1,
  price integer not null default 0 check (price >= 0),
  label text not null default '',
  kind text not null default '',
  sort integer not null default 0
);
create table if not exists announcements(
  id serial primary key,
  title text not null,
  price integer not null,
  description text not null default '',
  whatsapp text not null default '',
  img text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists payments(
  id serial primary key,
  user_id integer not null references users(id),
  method text not null check (method in ('moncash','natcash')),
  amount integer not null check (amount > 0),
  code text not null,
  status text not null default 'wait' check (status in ('wait','ok','no')),
  credited integer not null default 0,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists payments_code_uq on payments (method, lower(code));
create table if not exists orders(
  id serial primary key,
  user_id integer not null references users(id),
  game text not null,
  unit text not null default '',
  pack_label text not null default '',
  qty integer not null default 1,
  price integer not null,
  player_id text not null,
  player_name text not null default '',
  whatsapp text not null default '',
  status text not null default 'wait' check (status in ('wait','verified','liv','no')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_user on orders(user_id, created_at desc);
create table if not exists spin_rewards(
  id serial primary key,
  user_id integer not null references users(id),
  name text not null,
  diamonds integer not null default 0,
  status text not null default 'unclaimed' check (status in ('unclaimed','claimed','delivered')),
  claim_uid text not null default '',
  claim_pseudo text not null default '',
  claim_wa text not null default '',
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  delivered_at timestamptz
);
create index if not exists rewards_user on spin_rewards(user_id, created_at desc);
`;

async function seed() {
  const defaults = {
    name: 'ZHUO FAN HT', moncash: '509 0000 0000', natcash: '', whatsapp: '',
    spin_price: '50', guide_channel: '',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await q('insert into settings(key,value) values($1,$2) on conflict (key) do nothing', [k, v]);
  }

  const { rows } = await q('select count(*)::int as n from games');
  if (rows[0].n === 0) {
    const mk = async (name, unit, color, sort, packs) => {
      const g = (await q('insert into games(name,unit,color,sort) values($1,$2,$3,$4) returning id', [name, unit, color, sort])).rows[0];
      let i = 0;
      for (const p of packs) {
        await q('insert into packs(game_id,qty,price,label,kind,sort) values($1,$2,$3,$4,$5,$6)',
          [g.id, p.qty, p.price || 0, p.label || '', p.kind || '', i++]);
      }
    };
    // Prix à 0 = "à définir par l'admin" (commande impossible tant que le prix n'est pas fixé)
    await mk('Free Fire', 'Diamants', '#5a2a2a', 0, [
      { qty: 110 }, { qty: 220 }, { qty: 341 }, { qty: 572 }, { qty: 660 },
      { qty: 1060, price: 1650 }, { qty: 2000 },
      { qty: 1, label: 'Abonnement mois', kind: 'month' },
      { qty: 1, label: 'Abonnement semaine', kind: 'week' },
      { qty: 1, label: 'Booyah Pass', kind: 'booyah' },
      { qty: 1, label: 'Abonnement VIP', kind: 'lvl' },
    ]);
    await mk('Blood Strike', 'Gold', '#7a1e1e', 1, [
      { qty: 100, price: 150 }, { qty: 300, price: 430 }, { qty: 520, price: 760 }, { qty: 1000, price: 1400 },
    ]);
    await mk('DLS', 'Coins', '#8a9a2a', 2, [
      { qty: 500, price: 200 }, { qty: 1000, price: 380 }, { qty: 2500, price: 900 },
    ]);
    await mk('COD Mobile', 'CP', '#555555', 3, [
      { qty: 80, price: 150 }, { qty: 400, price: 700 }, { qty: 800, price: 1350 },
    ]);
  }

  const ap = process.env.ADMIN_PSEUDO, apw = process.env.ADMIN_PASSWORD;
  if (ap && apw) {
    const hash = await bcrypt.hash(apw, 11);
    const ex = (await q('select id from users where lower(pseudo)=lower($1)', [ap])).rows[0];
    if (ex) await q("update users set role='admin', pass_hash=$2 where id=$1", [ex.id, hash]);
    else await q("insert into users(pseudo,pass_hash,role) values($1,$2,'admin')", [ap, hash]);
    console.log('[init] compte admin prêt:', ap);
  } else {
    console.warn('[init] ADMIN_PSEUDO / ADMIN_PASSWORD non définis: aucun admin ne sera créé.');
  }
}

async function init() {
  await q(SCHEMA);
  await seed();
}

module.exports = { pool, q, tx, init };
