// Netlify Scheduled Function (v2 syntax) — runs once a day and decides which
// email alerts to send: (1) recordatorio general el día 7, (2) alertas de
// vencimiento por deuda según `diaNotificacion`, (3) alerta predictiva de
// Revolut 5 días antes de la fecha proyectada de llegar a su tope.
//
// Required env vars (set in Netlify → Site settings → Environment variables):
//   FIREBASE_SERVICE_ACCOUNT_B64  base64 of the Firebase service account JSON
//   FIREBASE_DB_URL               e.g. https://xxx-default-rtdb.firebaseio.com
//   RESEND_API_KEY                Resend API key
//   ALERT_FROM_EMAIL              e.g. alerts@yourdomain.com (verified in Resend)
//   ALERT_TO_EMAIL                where alerts are delivered

import admin from 'firebase-admin';

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('Falta FIREBASE_SERVICE_ACCOUNT_B64');
  const serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
}

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const fmtMoney = (n) => (n === null || n === undefined || Number.isNaN(n)) ? 'pendiente de confirmar' : MXN.format(n);

function mexicoCityToday() {
  // El scheduler corre en UTC; convertimos a la fecha calendario de CDMX (UTC-6, sin horario de verano).
  const now = new Date(Date.now() - 6 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function addDaysISO(dateISO, n) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function movingAverage(historialInteres, windowDays = 7) {
  const entries = Object.values(historialInteres || {})
    .filter((e) => typeof e.monto === 'number')
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  if (!entries.length) return null;
  const recent = entries.slice(-windowDays);
  return recent.reduce((s, e) => s + e.monto, 0) / recent.length;
}

function revolutAlertDate(cuenta) {
  const tope = cuenta?.tasas?.[0]?.hasta ?? 25000;
  if (!cuenta || cuenta.saldo >= tope) return null;
  const avg = movingAverage(cuenta.historialInteres, 7);
  if (!avg || avg <= 0) return null;
  const diasRestantes = Math.ceil((tope - cuenta.saldo) / avg);
  const fechaProyectada = addDaysISO(mexicoCityToday(), diasRestantes);
  return { fechaProyectada, fechaAlerta: addDaysISO(fechaProyectada, -5), tope };
}

async function sendEmail({ subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL,
      to: [process.env.ALERT_TO_EMAIL],
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
}

function buildSummaryEmail(rendimientos, deudas) {
  const totalRendimientos = Object.values(rendimientos || {}).reduce((s, c) => {
    if (c.tipo === 'grupo_colector') return s + Object.values(c.cuentas || {}).reduce((s2, sc) => s2 + sc.saldo, 0);
    return s + (c.saldo || 0);
  }, 0);
  const deudasArr = Object.values(deudas || {});
  const totalDeudas = deudasArr.filter((d) => !d.montoPendiente).reduce((s, d) => s + (d.montoTotal || 0), 0);
  const pendientes = deudasArr.filter((d) => d.montoPendiente).map((d) => d.institucion);
  const html = `
    <h2>Resumen mensual de patrimonio</h2>
    <p><b>Rendimientos:</b> ${fmtMoney(totalRendimientos)}</p>
    <p><b>Deudas conocidas:</b> ${fmtMoney(totalDeudas)}</p>
    <p><b>Patrimonio neto:</b> ${fmtMoney(totalRendimientos - totalDeudas)}</p>
    ${pendientes.length ? `<p><i>No incluido (monto pendiente de confirmar): ${pendientes.join(', ')}</i></p>` : ''}
  `;
  return { key: 'resumen_mensual', subject: 'Patrimonio Tracker — Resumen mensual', html };
}

function buildDebtAlert(deuda) {
  const html = `
    <h2>Recordatorio de pago — ${deuda.institucion}</h2>
    <p>Monto: ${fmtMoney(deuda.montoTotal)}</p>
    <p>Pago mensual: ${deuda.pagoMensualPendiente || deuda.pagoMensual == null ? 'no definido' : fmtMoney(deuda.pagoMensual)}</p>
    ${deuda.diaVencimiento ? `<p>Vence el día ${deuda.diaVencimiento}</p>` : ''}
  `;
  return { key: `deuda_${deuda.institucion}`, subject: `Patrimonio Tracker — Recordatorio: ${deuda.institucion}`, html };
}

function buildRevolutAlert(proj) {
  const html = `
    <h2>Revolut está por llegar a su tope</h2>
    <p>Fecha proyectada de llegar a ${fmtMoney(proj.tope)}: <b>${proj.fechaProyectada}</b></p>
    <p>La tasa del excedente sobre ${fmtMoney(proj.tope)} sigue pendiente de confirmar. Considera detener aportaciones adicionales o mover el excedente mientras confirmas la tasa.</p>
  `;
  return { key: 'revolut_predictivo', subject: 'Patrimonio Tracker — Revolut cerca de su tope', html };
}

// Misma lógica que totalDailyGain() en index.html — mantenlas iguales si se edita una.
// El excedente de Revolut sobre su tope no se cuenta mientras su tasa siga pendiente.
function totalDailyGain(rendimientos) {
  let total = 0;
  for (const cuenta of Object.values(rendimientos || {})) {
    if (cuenta.tipo === 'grupo_colector') {
      for (const sub of Object.values(cuenta.cuentas || {})) {
        total += (sub.saldo || 0) * ((sub.tasaAnual || 0) / 365);
      }
    } else if (cuenta.tipo === 'escalonado_predictivo') {
      const tope = cuenta.tasas?.[0]?.hasta ?? Infinity;
      const tasa1 = cuenta.tasas?.[0]?.tasaAnual ?? 0;
      total += Math.min(cuenta.saldo || 0, tope) * (tasa1 / 365);
    } else {
      total += (cuenta.saldo || 0) * ((cuenta.tasaAnual || 0) / 365);
    }
  }
  return total;
}

// Acredita al contador de ganancias lo que generaron las cuentas hoy, una sola
// vez por día (idempotente si la función corre más de una vez el mismo día).
// El usuario puede reiniciar este contador a $0 desde la app cuando quiera.
async function accrueDailyGain(db, rendimientos, today) {
  const ref = db.ref('patrimonio/ganancias');
  const snap = await ref.once('value');
  const g = snap.val() || { acumulado: 0, resetTs: Date.now(), historial: {} };
  if (g.ultimaFechaAcreditada === today) return; // ya se acreditó hoy
  const gananciaHoy = totalDailyGain(rendimientos);
  await ref.update({
    acumulado: (g.acumulado || 0) + gananciaHoy,
    ultimaFechaAcreditada: today,
    [`historial/${today}`]: gananciaHoy,
  });
}

export default async () => {
  const app = initAdmin();
  const db = app.database();
  const today = mexicoCityToday();
  const dayOfMonth = parseInt(today.slice(8, 10), 10);

  const [rendimientosSnap, deudasSnap] = await Promise.all([
    db.ref('patrimonio/rendimientos').once('value'),
    db.ref('patrimonio/deudas').once('value'),
  ]);
  const rendimientos = rendimientosSnap.val() || {};
  const deudas = deudasSnap.val() || {};

  await accrueDailyGain(db, rendimientos, today);

  const alerts = [];

  if (dayOfMonth === 7) alerts.push(buildSummaryEmail(rendimientos, deudas));

  for (const deuda of Object.values(deudas)) {
    if (deuda.diaNotificacion === dayOfMonth) alerts.push(buildDebtAlert(deuda));
  }

  const revolut = rendimientos.revolut;
  if (revolut) {
    const proj = revolutAlertDate(revolut);
    if (proj && proj.fechaAlerta === today) alerts.push(buildRevolutAlert(proj));
  }

  const logRef = db.ref(`patrimonio/alertsLog/${today}`);
  const logSnap = await logRef.once('value');
  const sentToday = logSnap.val() || {};

  let sent = 0;
  for (const alert of alerts) {
    if (sentToday[alert.key]) continue; // ya se envió hoy, evita duplicados si la función corre más de una vez
    await sendEmail(alert);
    await logRef.child(alert.key).set(true);
    sent += 1;
  }

  return new Response(JSON.stringify({ ok: true, evaluated: alerts.length, sent, gananciaHoy: totalDailyGain(rendimientos) }), {
    headers: { 'content-type': 'application/json' },
  });
};

export const config = {
  // 06:00 hora CDMX = 12:00 UTC (CDMX no observa horario de verano desde 2022)
  schedule: '0 12 * * *',
};
