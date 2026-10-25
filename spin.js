// Logique du Spin, côté serveur (le résultat ne peut plus être triché dans le navigateur).
// Les poids `w` sont des POURCENTAGES (comme dans le front : Math.random()*100 puis soustraction).
const crypto = require('crypto');

const PRIZES = [
  { n: 0,  v: 10000, w: .01,  t: 'jackpot', nm: '💎 10 000' },
  { n: 2,  v: 110,   w: .002, t: 'small',   nm: '💎 110' },
  { n: 4,  v: 0,     w: .2,   t: 'big',     nm: 'Abonnement semaine' },
  { n: 6,  v: 572,   w: .18,  t: 'mid',     nm: '💎 572' },
  { n: 8,  v: 220,   w: 0,    t: 'small',   nm: '💎 220' },          // gagné via le 3e pack ×5
  { n: 10, v: 0,     w: .08,  t: 'big',     nm: 'Abonnement mois' },
  { n: 12, v: 2000,  w: .05,  t: 'big',     nm: '💎 2 000 + bonus' },
  { n: 14, v: 341,   w: .25,  t: 'mid',     nm: '💎 341' },
  { n: 16, v: 0,     w: .02,  t: 'big',     nm: 'Abonnement VIP' },
  { n: 18, v: 660,   w: .15,  t: 'mid',     nm: '💎 660' },
  { n: 20, v: 0,     w: .05,  t: 'big',     nm: 'Booyah Pass' },
  { n: 22, v: 1060,  w: .1,   t: 'big',     nm: '💎 1 060 + bonus' },
];
const SLOTS = 24;
const taken = new Set(PRIZES.map(p => p.n));
const LOSE = [];
for (let i = 0; i < SLOTS; i++) if (!taken.has(i)) LOSE.push({ n: i, v: 0, w: 0, t: 'lose', nm: 'Perdu' });
const GUARANTEED = PRIZES.find(p => p.n === 8);

function roll() {
  let r = crypto.randomInt(0, 1e9) / 1e7; // 0 <= r < 100
  for (const p of PRIZES) { r -= p.w; if (r < 0) return p; }
  return LOSE[crypto.randomInt(0, LOSE.length)];
}
function rollFinal(forceGuarantee) {
  const p = roll();
  return (p.t === 'lose' && forceGuarantee) ? GUARANTEED : p;
}
function publicConfig(price) {
  const totalPct = PRIZES.reduce((a, p) => a + p.w, 0);
  return {
    price,
    totalWinChancePct: Number(totalPct.toFixed(4)),
    prizes: PRIZES.map(p => ({ slot: p.n, name: p.nm, diamonds: p.v, type: p.t, chancePct: p.w })),
    note: 'Pack ×5 : le 3e pack consécutif garantit 💎 220 sur le dernier tour s’il est perdant.',
  };
}
module.exports = { rollFinal, publicConfig, PRIZES };
