# Patrimonio Tracker

App web independiente para ver en un solo lugar: cuentas de rendimiento en México, deudas de tarjetas de crédito, y el patrimonio neto resultante. Sigue el mismo patrón técnico que "Disciplina Diaria": un solo `index.html` con vanilla JS, Firebase Realtime Database, service worker (PWA), y despliegue automático en Netlify vía GitHub.

## Stack
- Vanilla JS (sin frameworks), un solo `index.html`
- Firebase Realtime Database (persistencia) + Firebase Auth email/password (acceso)
- Netlify (hosting estático + Scheduled Function para los correos)
- Resend (envío de correos)

---

## 1. Crear el proyecto de Firebase

1. Ve a [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → nómbralo `patrimonio-tracker`.
2. **Build → Realtime Database → Create database** (modo *locked*, elige la región más cercana, ej. `us-central1`).
3. Sube las reglas de este repo: pestaña **Rules**, pega el contenido de [`database.rules.json`](./database.rules.json) y publica. Esto exige `auth != null` para leer o escribir — nadie sin sesión puede tocar tus datos, aunque la URL de la base sea pública.
4. **Build → Authentication → Sign-in method** → habilita **Email/Password**.
5. **Authentication → Users → Add user** → crea tu propio usuario (el correo/contraseña con los que vas a iniciar sesión en la app).
6. **Project settings → General → Your apps → Web app (</>) ** → registra la app y copia el objeto `firebaseConfig`.
7. Pega esos valores en `index.html`, en el bloque:
   ```js
   const firebaseConfig = { apiKey: "...", authDomain: "...", databaseURL: "...", ... };
   ```
   > El `firebaseConfig` del cliente **no es secreto** — Google lo expone así a propósito. La seguridad real la dan las Database Rules del paso 3, no ocultar esta config.
8. **Project settings → Service accounts → Generate new private key** → descarga el JSON. Lo vas a necesitar en el paso 3 (Netlify), no lo subas al repo.

## 2. Push a GitHub

```bash
git add .
git commit -m "Patrimonio Tracker: setup inicial"
git push -u origin main
```

## 3. Conectar Netlify

1. En [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → conecta este repo de GitHub.
2. Build command: vacío. Publish directory: `.` (ya está en `netlify.toml`).
3. **Site settings → Environment variables**, agrega:
   | Variable | Valor |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT_B64` | `cat serviceAccount.json \| base64 -w0` (el JSON del paso 1.8) |
   | `FIREBASE_DB_URL` | tu Realtime Database URL, ej. `https://patrimonio-tracker-xxxx-default-rtdb.firebaseio.com` |
   | `RESEND_API_KEY` | tu API key de [resend.com](https://resend.com) |
   | `ALERT_FROM_EMAIL` | remitente verificado en Resend |
   | `ALERT_TO_EMAIL` | `nicolasaltamirano025@gmail.com` |
4. Deploy. La Netlify Function programada (`netlify/functions/daily-alerts.js`) corre sola todos los días a las 07:00 hora CDMX (`schedule: "0 13 * * *"` en UTC) — no necesitas Cloud Scheduler aparte, Netlify Scheduled Functions ya trae su propio cron.

### Por qué Netlify Function + Resend (y no Firebase Cloud Functions)
Firebase Cloud Functions con cron requiere el plan **Blaze** (pago por uso) solo para poder programar funciones. Netlify Scheduled Functions vienen incluidas en el plan gratuito y ya estás desplegando ahí, así que es la opción con menos piezas nuevas que aprender/pagar. Resend tiene una API mínima (un solo `fetch` a un endpoint) y un plan gratuito de sobra para ~10 correos/mes.

### Token de acceso a GitHub
Si tu integración Netlify↔GitHub para este repo privado usa un Personal Access Token en vez de la GitHub App de Netlify: genera uno con **scope `repo` únicamente**, y ponte un recordatorio para regenerarlo cada 7 días (mismo criterio que Disciplina Diaria).

## 4. Checklist antes de cada deploy

```bash
# Verifica que no haya errores de sintaxis en la función de alertas
node --check netlify/functions/daily-alerts.js

# Si editaste JS embebido en index.html, extráelo a un .js temporal y corre
# node --check sobre eso antes de pegarlo de vuelta.
```

Bumpea `CACHE_NAME` en `sw.js` (ej. `patrimonio-tracker-v2`) en cada deploy que cambie `index.html`, para que los usuarios no se queden con una versión cacheada vieja.

```bash
git add .
git commit -m "descripción del cambio"
git push
# Netlify despliega automáticamente en ~1 minuto
```

---

## Modelo de datos (Realtime Database)

```
patrimonio/
  rendimientos/
    {id}/
      tipo: "simple" | "escalonado_predictivo" | "declining_vinculado" | "grupo_colector"
      nombre, saldo, tasaAnual        # tipo simple / declining_vinculado
      tasas: [{hasta, tasaAnual}, {desde, tasaAnual|null, pendiente}]  # escalonado_predictivo
      historialInteres: { {id}: {fecha, monto} }                       # escalonado_predictivo
      deudaVinculadaId, cicloDia                                       # declining_vinculado
      cuentas: { c1: {...}, c2: {...}, c3: {...} }                     # grupo_colector
  deudas/
    {id}/
      institucion, montoTotal, montoPendiente, pagoMensual, pagoMensualPendiente,
      diaCorte, diaVencimiento, diaNotificacion, cuentaRendimientoVinculadaId, notas
  movimientos/       # historial combinado, editable/eliminable
  snapshots/          # {fecha, totalRendimientos, totalDeudas, patrimonioNeto} — uno por día, alimenta la gráfica y la tendencia
  alertsLog/{fecha}/{clave}: true   # evita reenviar la misma alerta el mismo día
```

## Carga inicial de datos

La app detecta si `patrimonio/` está vacío y muestra un banner **"Cargar datos iniciales"** que precarga las 4 cuentas de rendimiento y las 7 deudas descritas en la especificación original (Revolut, Nu, Klar ×3, Uala / Nu deuda, Mercado Pago, Klar deuda, INVEX, Uala deuda, BBVA, Claro-pendiente), con el vínculo Nu↔Nu ya configurado. Los 5 valores de `historialInteres` de Revolut son una semilla estimada a partir del rango que diste (9.71–9.73 MXN/día) — edítalos con tus valores reales apenas los tengas, para que la proyección sea exacta.

## Qué recalcula la app en cada carga
- Balance de cada cuenta, proyecciones a 30/90/365 días.
- Fecha proyectada de Revolut y fecha de alerta (proyección − 5 días), usando el promedio móvil de interés diario **registrado**, no la tasa nominal.
- Total de deudas conocidas (excluye montos "pendiente", los marca explícitamente).
- Patrimonio neto y su tendencia vs. el snapshot anterior.

## Qué NO hace la app (para no asumir datos)
- No calcula nada sobre la tasa de excedente de Revolut mientras esté marcada `pendiente` — solo avisa.
- No incluye a Claro en ningún total mientras su monto siga sin capturar.
- No pone un pago mensual a una deuda si tú no lo diste — la muestra como "no definido" y la excluye de la suma de pagos conocidos.
