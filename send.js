// Sender varsler fra treningsdagboka.
// Kjøres av GitHub hvert 10. minutt (se varsler.yml).
// 1) Sender meldinger som treneren har lagt i køen (ny video, kommentar, plan, testvarsel).
// 2) Én gang om morgenen: bursdager, høytider og stevner om 3 dager.
// 3) Om kvelden: påminnelse om å føre dagens planlagte økt (Emma kl. 20, Sanna kl. 21 som standard).
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const UTOVERE = { sanna: 'Sanna', emma: 'Emma' };

let sa;
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch { sa = null; }
if (!sa || !sa.project_id) {
  console.error('Fant ikke nøkkelen. Sjekk at FIREBASE_SERVICE_ACCOUNT er lagt inn under Settings → Secrets and variables → Actions.');
  process.exit(1);
}
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const fcm = getMessaging();

function osloNow() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(mo)}-${pad(da)}`;
}

async function send(til, title, body, url) {
  til = (til || []).filter(Boolean).slice(0, 30);
  if (!til.length) return 0;
  const snap = await db.collection('push').where('who', 'in', til).get();
  const tokens = snap.docs.map((d) => ({ ref: d.ref, token: d.data().token })).filter((t) => t.token);
  if (!tokens.length) { console.log(`Ingen enheter har slått på varsler for: ${til.join(', ')}`); return 0; }
  const res = await fcm.sendEach(tokens.map((t) => ({
    token: t.token,
    data: { title: String(title), body: String(body || ''), url: String(url || './') },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
  })));
  let ok = 0;
  await Promise.all(res.responses.map(async (r, i) => {
    if (r.success) { ok++; return; }
    const code = (r.error && r.error.code) || '';
    console.log(`Kunne ikke sende til en enhet: ${code}`);
    if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) {
      await tokens[i].ref.delete();
    }
  }));
  return ok;
}

async function sendQueue() {
  const q = await db.collection('varsler').where('sendt', '==', false).limit(50).get();
  for (const d of q.docs) {
    const v = d.data();
    const n = await send(v.til, v.tittel || 'Treningsdagboka', v.tekst, v.url);
    await d.ref.update({ sendt: true, sendtTid: new Date().toISOString(), antall: n });
    console.log(`Sendt «${v.tittel}» til ${(v.til || []).join(', ')} (${n} enheter)`);
  }
  if (!q.size) console.log('Ingen nye varsler i køen.');
}

async function daily(date) {
  const md = date.slice(5), y = Number(date.slice(0, 4)), alle = Object.keys(UTOVERE);
  // Bursdager
  const u = await db.collection('utovere').get();
  for (const d of u.docs) {
    const f = d.data().fodt || '';
    if (UTOVERE[d.id] && f.slice(5) === md) {
      const age = y - Number(f.slice(0, 4));
      await send([d.id], `Gratulerer med dagen, ${UTOVERE[d.id]}! 🎉`, `Hipp hipp hurra! ${age} år i dag.`, './#oversikt');
    }
  }
  // Høytider
  const fest = md === '12-24' ? ['🎄 God jul!', 'Håper du får en riktig fin julaften.']
    : md === '12-31' ? ['🎆 Godt nyttår!', `Takk for innsatsen i ${y}. Lykke til i ${y + 1}!`]
    : md === '05-17' ? ['🇳🇴 Gratulerer med dagen!', 'Hipp hipp hurra! Ha en riktig fin 17. mai.']
    : date === addDays(easter(y), -1) ? ['🐣 God påske!', 'Håper du får noen fine påskedager.']
    : null;
  if (fest) await send(alle, fest[0], fest[1], './#oversikt');
  // Stevner om 3 dager
  const d3 = addDays(date, 3);
  const st = await db.collection('stevner').where('dato', '==', d3).get();
  for (const d of st.docs) {
    const x = d.data();
    const til = x.who === 'begge' ? alle : [x.who];
    await send(til, `${x.navn} om 3 dager`, 'Lykke til! Husk god søvn, mat og drikke de neste dagene.', './#mal');
  }
}

const PM_STD = { sanna: 21, emma: 20 };
async function evening(date, hour) {
  const inn = (await db.collection('innstillinger').doc('paaminnelse').get()).data() || {};
  let plan = null, okt = null;
  for (const k of Object.keys(UTOVERE)) {
    const v = inn[k];
    if (v === false) continue;
    const h = typeof v === 'number' ? v : (PM_STD[k] ?? 20);
    if (hour < h) continue;
    const ref = db.collection('varsellogg').doc(`kveld-${date}-${k}`);
    if ((await ref.get()).exists) continue;
    await ref.set({ tid: new Date().toISOString() });
    if (!plan) plan = (await db.collection('okplan').where('dato', '==', date).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!okt) okt = (await db.collection('okter').where('dato', '==', date).get()).docs.map((d) => d.data());
    if (okt.some((o) => o.who === k)) continue; // har allerede ført en økt i dag
    const mine = plan.filter((p) => (p.who === 'begge' || p.who === k) && !(p.hopp || []).includes(k));
    if (!mine.length) continue;
    await send([k], 'Husk å føre dagens økt 📝', mine.map((p) => p.tittel).join(', '), './#plan');
    console.log(`Kveldspåminnelse sendt til ${UTOVERE[k]}.`);
  }
}

await sendQueue();
const { date, hour } = osloNow();
if (hour >= 7) {
  const ref = db.collection('varsellogg').doc('dag-' + date);
  if (!(await ref.get()).exists) {
    await ref.set({ tid: new Date().toISOString() });
    await daily(date);
    console.log(`Morgensjekk for ${date} er gjort.`);
  }
}
if (hour >= 17) await evening(date, hour);
