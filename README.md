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
3. Sube las reglas de este repo: pestaña **Rules**, pega el contenido de [`database.rules.json`](./database.rules.json) y publica. Esto exige `auth != null` para leer o escribir. **Importante**: estas son las reglas de arranque, no las finales — una vez que migres tus datos a tu propio usuario (ver sección **Multiusuario** más abajo), las reemplazas por [`database.rules.per-user.json`](./database.rules.per-user.json), que sí aísla los datos de cada usuario del resto.
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
   | `MIGRATION_SECRET` | cualquier cadena larga que inventes — solo la usas una vez, para la migración inicial |
4. Deploy. La Netlify Function programada (`netlify/functions/daily-alerts.js`) corre sola todos los días a las 06:00 hora CDMX (`schedule: "0 12 * * *"` en UTC) — no necesitas Cloud Scheduler aparte, Netlify Scheduled Functions ya trae su propio cron. Cada usuario recibe sus alertas en el correo con el que inició sesión (no hay una dirección fija de destino).

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

## Multiusuario (estructura lista, desactivada por ahora)

Por ahora la app sigue siendo de un solo usuario — el login es simple, sin "Crear cuenta" ni "¿Olvidaste tu contraseña?" visibles, igual que siempre. Pero por debajo, los datos ya están organizados por usuario: todo lo que antes vivía en `patrimonio/...` ahora vive en `patrimonio/{uid}/...`, donde `uid` es tu ID de Firebase Auth, y `netlify/functions/daily-alerts.js` ya está escrito para procesar a cualquier cantidad de usuarios que existan. Si en el futuro hace falta dar de alta a alguien más, no hay que rehacer nada de esto — ver "Si en el futuro agregan a alguien" más abajo.

### Migrar tus datos actuales a tu propio usuario (necesario, hazlo UNA sola vez)
Como ya tenías datos guardados en la ruta vieja (`patrimonio/rendimientos`, `patrimonio/deudas`, etc., sin usuario) y el código ya espera `patrimonio/{tu-uid}/...`, necesitas correr esta migración una sola vez para que tus cuentas, deudas e historial vuelvan a aparecer en la app — si no la corres, vas a ver la app vacía al iniciar sesión (tus datos viejos siguen intactos, solo que en otra ruta).

1. En Netlify → Environment variables, confirma que `MIGRATION_SECRET` ya tiene un valor tuyo (cualquier cadena larga que hayas inventado).
2. Abre en el navegador (reemplaza con tus valores):
   ```
   https://TU-SITIO.netlify.app/.netlify/functions/migrate-user-data?email=nicolasaltamirano025@gmail.com&secret=TU_MIGRATION_SECRET
   ```
   Deberías ver algo como `{"ok":true,"uid":"...","migratedKeys":["rendimientos","deudas","movimientos","snapshots","ganancias","crecimiento"]}`.
3. Entra a la app normal, inicia sesión, y confirma que ves tus cuentas, deudas y el historial de siempre.
4. (Opcional) Una vez tranquilo con que todo migró bien, puedes borrar manualmente los nodos viejos `patrimonio/rendimientos`, `patrimonio/deudas`, etc. desde la consola de Firebase — ya no los usa nadie. No hay prisa, no estorban.

Las Database Rules **no cambian** por ahora — siguen siendo las de [`database.rules.json`](./database.rules.json) (`auth != null`), que para un solo usuario funcionan igual de bien. No hace falta tocarlas mientras sigas siendo tú solo.

### Si en el futuro agregan a alguien
1. En Firebase console → Authentication → Users → **Add user**, créale su correo/contraseña (2 minutos, como se hizo contigo).
2. En Firebase console → Realtime Database → **Rules**, reemplaza el contenido por el de [`database.rules.per-user.json`](./database.rules.per-user.json) y publica — esto hace que cada quien solo pueda leer/escribir su propio `patrimonio/{su-uid}/...`.
3. Esa persona entra a la app con su correo/contraseña y arranca con su patrimonio completamente vacío, separado del tuyo — `daily-alerts.js` ya le manda sus propias alertas a su propio correo sin que haya que tocar nada más.

(Si más adelante prefieren que la gente pueda crear su propia cuenta sin que tú se las armes a mano en Firebase, se puede volver a agregar el botón de "Crear cuenta" con una lista blanca de correos — ya lo construimos una vez, es rápido de reactivar.)

---

## Modelo de datos (Realtime Database)

```
patrimonio/
  {uid}/                 # un árbol completo por usuario (Firebase Auth uid) — ver sección Multiusuario
    rendimientos/
      {id}/
        tipo: "simple" | "escalonado_predictivo" | "declining_vinculado" | "grupo_colector" | "no_compuesto"
        nombre, saldo, tasaAnual        # tipo simple / declining_vinculado / no_compuesto
        tasas: [{hasta, tasaAnual}, {desde, tasaAnual|null, pendiente}]  # escalonado_predictivo
        historialInteres: { {id}: {fecha, monto} }                       # escalonado_predictivo, solo afina la proyección
        deudaVinculadaId, cicloDia                                       # declining_vinculado
        cuentas: { c1: {...}, c2: {...}, c3: {...} }                     # grupo_colector
        cuentaDestinoId                                                  # no_compuesto: a dónde se va su rendimiento
        notificarTope: { activo, monto, diasAviso, notificadoLlegada }   # opcional, cualquier tipo
        recordatorioAccion: { activo, diaMes, nota }                     # opcional, cualquier tipo
    deudas/
      {id}/
        institucion, montoTotal, montoPendiente, pagoMensual, pagoMensualPendiente,
        diaCorte, diaVencimiento, diaNotificacion, cuentaRendimientoVinculadaId, notas
    movimientos/       # historial combinado, editable/eliminable
    snapshots/          # {fecha, totalRendimientos, totalDeudas, patrimonioNeto} — uno por día, alimenta la gráfica y la tendencia
    ganancias/          # { acumulado, resetTs, historial: {fecha: gananciaDelDia} } — reiniciable por el usuario
    crecimiento/        # { ultimaFechaAplicada } — guardia interna, evita crecer los saldos dos veces el mismo día
    alertsLog/{fecha}/{clave}: true   # evita reenviar la misma alerta el mismo día
```


## Carga inicial de datos

La app detecta si `patrimonio/` está vacío y muestra un banner **"Cargar datos iniciales"** que precarga las 4 cuentas de rendimiento y las 7 deudas descritas en la especificación original (Revolut, Nu, Klar ×3, Uala / Nu deuda, Mercado Pago, Klar deuda, INVEX, Uala deuda, BBVA, Claro-pendiente), con el vínculo Nu↔Nu ya configurado. Los 5 valores de `historialInteres` de Revolut son una semilla estimada a partir del rango que diste (9.71–9.73 MXN/día) — edítalos con tus valores reales apenas los tengas, para que la proyección sea exacta.

## Qué recalcula la app en cada carga
- Balance de cada cuenta, proyecciones a 30/90/365 días.
- Fecha proyectada de Revolut y fecha de alerta (proyección − 5 días), usando el promedio móvil de interés diario **registrado**, no la tasa nominal.
- Total de deudas conocidas (excluye montos "pendiente", los marca explícitamente).
- Patrimonio neto y su tendencia vs. el snapshot anterior.

## Crecimiento diario automático de saldos
La misma Netlify Function que manda las alertas (corre todos los días a las 6am CDMX) hace crecer el **saldo real** de cada cuenta con el interés de ese día, calculado con su tasa actual (`dailyGrowthForAccount`) — no necesitas actualizar el saldo a mano para que refleje el rendimiento. En Klar, el interés de las 3 subcuentas se deposita completo en la cuenta colectora (c3); c1 y c2 mantienen su principal, tal cual el flujo real del producto. Para Revolut, solo crece la parte dentro del tope de $25,000 mientras la tasa del excedente siga pendiente de confirmar. "Actualizar saldo" en cada tarjeta sigue existiendo, pero ahora es solo para correcciones manuales (ej. si depositaste o retiraste dinero).

## Cuánto genera cada cuenta
Arriba del saldo de cada tarjeta se ve "+$X hoy" (o "genera $X hoy" en una cuenta sin interés compuesto, ya que ese monto no se queda en su propio saldo) — es `dailyGrowthForAccount` más lo que reciba de otra cuenta vinculada. El mismo total de todas las cuentas también aparece junto al patrimonio neto arriba ("Generando ~$X hoy"), para no tener que bajar hasta la tarjeta de Ganancias a verlo.

## Tasa anualizada real
Junto a la etiqueta "Rendimientos" en la Zona A hay un pill con el % anual real que está dando tu dinero HOY: `(lo que generas hoy × 365 × 100) / total en rendimientos`. No es el promedio de las tasas nominales de tus cuentas — es cuánto rinde tu dinero de verdad, ponderado por cuánto tienes en cada cuenta (si tienes más dinero en una cuenta con tasa baja, este % se acerca más a esa tasa que a un simple promedio de todas).

## Gráfica de evolución del patrimonio
- Un snapshot por día (si hay varias escrituras el mismo día, se queda la más reciente).
- Fila de rendimiento a 7 / 30 / 90 días y total, con monto y % — se calcula contra el registro disponible más cercano a esa fecha; si no hay suficiente historial todavía, dice "sin datos" en vez de inventar un número.
- Eje Y con los montos máximo y mínimo del rango visible; eje X con la fecha del primer y último punto.
- Toca/haz clic en cualquier punto de la línea para ver su detalle abajo de la gráfica: fecha, patrimonio neto de ese día, diferencia contra el día anterior, y los movimientos registrados ese día (pagos, actualizaciones de saldo, etc.).
- El pill de arriba a la derecha de "Patrimonio neto" ahora muestra la ganancia acumulada (la misma de la tarjeta de Ganancias), no un delta día a día que se veía en $0.00 la mayoría del tiempo.

## Contador de ganancias
La tarjeta "Ganancia acumulada" arranca en $0 desde que se creó, y sube sola un día a la vez: cada vez que la función hace crecer los saldos, suma ese mismo monto al acumulado. El botón "Reiniciar" en esa tarjeta lo regresa a $0 en cualquier momento — no toca tus saldos ni el crecimiento diario, solo el contador (están desacoplados a propósito: `patrimonio/crecimiento` es la guardia real de "ya crecieron los saldos hoy", `patrimonio/ganancias` es solo el contador visible y reiniciable). "Hoy vas generando" es una estimación en vivo (se recalcula cada vez que abres la app) de lo que se va a acreditar cuando corra la función.

## Cuenta sin interés compuesto (tipo "no_compuesto")
Para cuentas como Finsus, donde el rendimiento no se queda ahí: tú lo retiras y lo metes a otra cuenta. Al crearla, elige el tipo "Sin interés compuesto" y la cuenta destino. Su propio saldo nunca crece — lo que genera cada día se deposita automáticamente en la cuenta destino (tanto en el crecimiento diario real como en las proyecciones a 30/90/365 días y en la alerta de tope). La tarjeta de origen muestra a dónde se va su rendimiento; la de destino muestra de dónde lo recibe.

## Recordatorio mensual de acción
Cualquier cuenta de rendimiento puede tener un recordatorio mensual de "hay que hacer algo aquí" (ej. "mover el rendimiento de Finsus a Klar"), con su propio día del mes y nota libre — se configura en el mismo formulario que el tope. Llega por correo ese día, igual que las alertas de deuda.

## Notificación de tope por cuenta
En el formulario de cada cuenta de rendimiento (botón "Actualizar saldo") hay una opción para activar "Notificarme cuando esta cuenta llegue a $X", con cuántos días de anticipación avisar (5 por defecto). Aplica a cualquier tipo de cuenta, no solo Revolut (que ya tiene su propia alerta dedicada basada en interés real registrado). La función diaria evalúa la proyección con la tasa nominal de la cuenta y manda el correo el día calculado; si el saldo ya alcanzó el tope, manda un aviso único de "ya llegaste".

## Qué NO hace la app (para no asumir datos)
- No calcula nada sobre la tasa de excedente de Revolut mientras esté marcada `pendiente` — solo avisa.
- No incluye a Claro en ningún total mientras su monto siga sin capturar.
- No pone un pago mensual a una deuda si tú no lo diste — la muestra como "no definido" y la excluye de la suma de pagos conocidos.
