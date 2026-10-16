// Netlify Function (HTTP, no programada) — migración de UN SOLO USO.
// Copia los datos "viejos" (de antes de que la app soportara varios usuarios,
// guardados sueltos en patrimonio/rendimientos, patrimonio/deudas, etc.) hacia
// patrimonio/{uid}/..., donde uid es el ID de Firebase Auth del usuario cuyo
// correo le pases. No borra ni toca los datos viejos — solo los copia.
//
// Uso (una sola vez, después de desplegar): abre en el navegador
//   https://TU-SITIO.netlify.app/.netlify/functions/migrate-user-data?email=TU_CORREO&secret=TU_SECRETO
//
// Protegida con un secreto compartido (MIGRATION_SECRET) para que nadie más
// pueda dispararla con solo adivinar la URL.
//
// Required env vars (además de los que ya usa daily-alerts.js):
//   MIGRATION_SECRET   cualquier cadena larga que tú inventes

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

const LEGACY_KEYS = ['rendimientos', 'deudas', 'movimientos', 'snapshots', 'ganancias', 'crecimiento', 'alertsLog'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async (req) => {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  const email = url.searchParams.get('email');

  if (!process.env.MIGRATION_SECRET || secret !== process.env.MIGRATION_SECRET) {
    return json({ ok: false, error: 'Secreto inválido o MIGRATION_SECRET no configurado en Netlify.' }, 403);
  }
  if (!email) {
    return json({ ok: false, error: 'Falta el parámetro ?email=' }, 400);
  }

  const app = initAdmin();
  const db = app.database();

  let uid;
  try {
    uid = (await app.auth().getUserByEmail(email)).uid;
  } catch (e) {
    return json({ ok: false, error: `No existe ningún usuario de Firebase Auth con ese correo: ${e.message}` }, 404);
  }

  // Ojo: NO revisamos patrimonio/{uid} completo, solo /rendimientos — la app
  // ya crea sola un "ganancias" en blanco la primera vez que inicias sesión
  // (antes de migrar), así que patrimonio/{uid} casi siempre "existe" aunque
  // tus cuentas y deudas reales todavía no se hayan copiado.
  const existingSnap = await db.ref(`patrimonio/${uid}/rendimientos`).once('value');
  if (existingSnap.exists()) {
    return json({ ok: false, error: `patrimonio/${uid}/rendimientos ya tiene datos — no se sobreescribe nada por seguridad. Bórralo manualmente en Firebase si de verdad quieres repetir la migración.` }, 409);
  }

  const migrated = {};
  for (const key of LEGACY_KEYS) {
    const snap = await db.ref(`patrimonio/${key}`).once('value');
    if (snap.exists()) migrated[key] = snap.val();
  }

  if (!Object.keys(migrated).length) {
    return json({ ok: false, error: 'No se encontraron datos antiguos en patrimonio/rendimientos, patrimonio/deudas, etc. — no hay nada que migrar.' }, 404);
  }

  // update() en vez de set(): así no borra el "ganancias" en blanco que ya se
  // haya creado solo, solo lo reemplaza si el dato viejo real existía.
  await db.ref(`patrimonio/${uid}`).update(migrated);

  return json({ ok: true, uid, migratedKeys: Object.keys(migrated) });
};
