// ═══════════════════════════════════════════════════════════════════════════
// COSÉTIKA — PLAN DE RECOMPENSAS
// Servicio independiente (Node.js puro), comparte la PostgreSQL de Railway con
// el dashboard. Regla: 10% del subtotal SIN IVA de cada factura de Contifico
// → saldo canjeable por productos con inventario en VERDE.
// Env vars requeridas: DATABASE_URL, CONTIFICO_API_KEY. Opcional: PORT.
// ═══════════════════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
let webpush; try { webpush = require('web-push'); } catch(e) { console.log('web-push no instalado'); }

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CONTIFICO_API_KEY || '';
const REGLA_PCT = 0.10; // 10% exacto sobre el TOTAL CON IVA de la factura
// (los precios del catálogo de canje son PVP con IVA, así que la base también lo es)

// ─── PUSH NOTIFICATIONS (mismas claves VAPID del dashboard) ──────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:info@cosetika.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('✓ Web Push VAPID configurado');
}

// Envía push a un grupo de suscripciones (limpia las expiradas automáticamente)
async function enviarPush(whereSql, params, payload) {
  if (!webpush || !VAPID_PUBLIC_KEY) return;
  try {
    const r = await pool.query(`SELECT endpoint, p256dh, auth, nombre FROM recompensas_push WHERE ${whereSql}`, params);
    if (!r.rows.length) return;
    const cuerpo = JSON.stringify(payload);
    await Promise.allSettled(r.rows.map(async sub => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, cuerpo);
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await pool.query('DELETE FROM recompensas_push WHERE endpoint=$1', [sub.endpoint]);
        }
      }
    }));
    console.log(`🔔 Push (${r.rows.length} dispositivos): ${payload.title}`);
  } catch(e) { console.error('Error push:', e.message); }
}
function pushEquipo(payload) { return enviarPush(`tipo='equipo'`, [], payload); }
function pushCliente(clienteId, payload) { return enviarPush(`tipo='cliente' AND cliente_id=$1`, [clienteId], payload); }

// Correo (Brevo, API HTTP — Railway bloquea SMTP): avisos de canjes.
// Env: BREVO_API_KEY (clave api de Brevo) · MAIL_FROM (remitente verificado en Brevo,
// ej. info@cosetika.com) · MAIL_EQUIPO (correos del equipo separados por comas).
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_EQUIPO = (process.env.MAIL_EQUIPO || '').split(',').map(s=>s.trim()).filter(Boolean);

async function enviarCorreo(destinos, asunto, html) {
  if (!BREVO_API_KEY || !MAIL_FROM || !destinos.length) return { ok:false, error:'Correo no configurado' };
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { email: MAIL_FROM, name: 'COSÉTIKA Recompensas' },
        to: destinos.map(e => ({ email: e })),
        subject: asunto,
        htmlContent: html
      })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(()=> '');
      console.error('Error correo Brevo:', resp.status, t.slice(0,200));
      return { ok:false, error:`HTTP ${resp.status}` };
    }
    console.log(`✉️ Correo enviado a ${destinos.join(', ')}: ${asunto}`);
    return { ok:true };
  } catch(e) { console.error('Error correo:', e.message); return { ok:false, error:e.message }; }
}

function htmlCorreo(titulo, cuerpo) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #eee;border-radius:12px;overflow:hidden">
    <div style="background:#1a0e08;padding:18px;text-align:center">
      <span style="color:#fff;font-size:18px;letter-spacing:3px">COSÉTIKA</span><br>
      <span style="color:#e8c9a8;font-size:11px;letter-spacing:1px">Plan de Recompensas</span>
    </div>
    <div style="padding:22px;color:#333;font-size:14px;line-height:1.6">
      <h2 style="color:#A0684A;font-size:17px;margin:0 0 12px">${titulo}</h2>
      ${cuerpo}
    </div>
  </div>`;
}

function htmlItemsCanje(items, total) {
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:10px 0">
    ${items.map(it=>`<tr><td style="padding:4px 0;border-bottom:1px solid #eee">${it.qty}× ${it.nombre}</td><td style="padding:4px 0;border-bottom:1px solid #eee;text-align:right">$${(it.precio*it.qty).toFixed(2)}</td></tr>`).join('')}
    <tr><td style="padding:6px 0;font-weight:bold">Total</td><td style="padding:6px 0;text-align:right;font-weight:bold;color:#A0684A">$${total.toFixed(2)}</td></tr>
  </table>`;
}

// WooCommerce (cosetika.com): fuente de PRECIOS (PVP web) y FOTOS de productos.
// Claves de solo lectura generadas en WooCommerce → Ajustes → Avanzado → REST API.
const WC_URL = (process.env.WC_URL || 'https://cosetika.com').replace(/\/$/, '');
const WC_KEY = process.env.WC_CONSUMER_KEY || '';
const WC_SECRET = process.env.WC_CONSUMER_SECRET || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── FECHAS ECUADOR ──────────────────────────────────────────────────────────
function nowEC() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }));
}
function fmtDateEC(d) { // DD/MM/YYYY (formato Contifico)
  const e = new Date(d.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }));
  return `${String(e.getDate()).padStart(2,'0')}/${String(e.getMonth()+1).padStart(2,'0')}/${e.getFullYear()}`;
}
function fechaDocASQL(ddmmyyyy) { // DD/MM/YYYY → YYYY-MM-DD
  const [d,m,y] = (ddmmyyyy||'').split('/');
  return (y && m && d) ? `${y}-${m}-${d}` : null;
}

// ─── CATÁLOGO DE PRODUCTOS (Contifico) con PRECIO ────────────────────────────
// [Supuesto] El PVP viene en pvp1; se prueban varios campos por si el nombre
// difiere en esta cuenta — ver /api/debug/producto-campos para diagnosticar.
let catalogoProductos = {}; // id → {nombre, marca, codigo, precio}
let catalogoSyncedAt = null;
let ejemploProductoCrudo = null;

function extraerPrecio(p) {
  const candidatos = [p.pvp1, p.precio1, p.pvp, p.precio, p.precio_venta, p.pvp_manual];
  for (const c of candidatos) {
    const v = parseFloat(c);
    if (!isNaN(v) && v > 0) return Math.round(v*100)/100;
  }
  return 0;
}

async function sincronizarCatalogo() {
  if (!API_KEY) { console.log('⚠️ Sin CONTIFICO_API_KEY — catálogo no sincronizado'); return; }
  try {
    const nuevos = {};
    let nextUrl = 'https://api.contifico.com/sistema/api/v2/producto/?page_size=100';
    let paginas = 0;
    while (nextUrl && paginas < 50) {
      const resp = await fetch(nextUrl, { headers: { 'Authorization': API_KEY, 'Accept': 'application/json' } });
      if (!resp.ok) break;
      const data = await resp.json();
      (data.results || []).forEach(p => {
        if (!ejemploProductoCrudo) ejemploProductoCrudo = p;
        if (p.id) nuevos[p.id] = {
          nombre: (p.nombre || '').trim(),
          marca: (p.marca_nombre || p.marca || '').trim().toUpperCase(),
          codigo: (p.codigo || '').trim(),
          precio: extraerPrecio(p)
        };
      });
      nextUrl = data.next || null;
      paginas++;
    }
    if (Object.keys(nuevos).length > 0) {
      catalogoProductos = nuevos;
      catalogoSyncedAt = new Date().toISOString();
      const conPrecio = Object.values(nuevos).filter(x=>x.precio>0).length;
      console.log(`✓ Catálogo: ${Object.keys(nuevos).length} productos (${conPrecio} con precio)`);
    }
  } catch(e) { console.error('Error catálogo:', e.message); }
}

// ─── WOOCOMMERCE: precios PVP y fotos por SKU ────────────────────────────────
let wooPorSku = {};      // SKU → { precio, imagen, nombre }
let wooSyncedAt = null;
let wooUltimoError = null;

async function sincronizarWoo() {
  if (!WC_KEY || !WC_SECRET) {
    wooUltimoError = 'Faltan WC_CONSUMER_KEY / WC_CONSUMER_SECRET en las variables';
    console.log('⚠️ WooCommerce: ' + wooUltimoError);
    return;
  }
  try {
    const nuevos = {};
    let pagina = 1, totalProds = 0;
    while (pagina <= 30) {
      const url = `${WC_URL}/wp-json/wc/v3/products?status=publish&per_page=100&page=${pagina}` +
        `&consumer_key=${encodeURIComponent(WC_KEY)}&consumer_secret=${encodeURIComponent(WC_SECRET)}`;
      const resp = await fetch(url, { headers: {
        'Accept': 'application/json',
        'Accept-Language': 'es-EC,es;q=0.9',
        'Authorization': 'Basic ' + Buffer.from(WC_KEY + ':' + WC_SECRET).toString('base64'),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      } });
      if (!resp.ok) {
        // Diagnóstico: identificar QUIÉN bloquea (Cloudflare deja cabecera cf-ray y
        // página propia; un plugin de WordPress devuelve JSON/HTML de WordPress)
        let cuerpo = '';
        try { cuerpo = (await resp.text()).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 260); } catch(e) {}
        const esCloudflare = !!resp.headers.get('cf-mitigated') || /cloudflare/i.test(cuerpo) ? ' [CLOUDFLARE]' : '';
        wooUltimoError = `HTTP ${resp.status}${esCloudflare} — ${cuerpo || 'sin detalle'}`;
        break;
      }
      const prods = await resp.json();
      if (!Array.isArray(prods) || prods.length === 0) break;
      prods.forEach(p => {
        const sku = (p.sku || '').trim();
        if (!sku) return;
        nuevos[sku] = {
          precio: Math.round((parseFloat(p.price) || 0)*100)/100,
          imagen: (p.images && p.images[0] && p.images[0].src) || null,
          nombre: p.name || ''
        };
      });
      totalProds += prods.length;
      if (prods.length < 100) break;
      pagina++;
    }
    if (Object.keys(nuevos).length > 0) {
      wooPorSku = nuevos;
      wooSyncedAt = new Date().toISOString();
      wooUltimoError = null;
      console.log(`✓ WooCommerce: ${totalProds} productos, ${Object.keys(nuevos).length} con SKU`);
    } else if (!wooUltimoError) {
      wooUltimoError = 'La tienda no devolvió productos con SKU';
    }
  } catch(e) {
    wooUltimoError = e.message;
    console.error('Error WooCommerce:', e.message);
  }
}

// ─── SEMÁFORO: directo del panel PROYECCIÓN del dashboard ────────────────────
// En vez de recalcular, se consulta /api/inventario del dashboard — la MISMA
// fuente que pinta la Proyección (bodegas POS + Casa unificadas, sincronizadas
// a diario desde Contifico). Así los colores siempre coinciden, incluso si
// Fernando cambia las reglas en el dashboard.
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://cosetika-dashboard-production.up.railway.app').replace(/\/$/, '');
let SEMAFOROS = { porId: {}, fecha_corte: null, synced_at: null, error: null };

async function cargarSemaforos() {
  try {
    const marcas = ['BIOSKIN','ERAYBA','ZIAJA','ZIAJA PRO'];
    const porId = {};
    let fechaCorte = null, ok = false, ultimoError = null;
    for (const m of marcas) {
      try {
        const resp = await fetch(`${DASHBOARD_URL}/api/inventario?marca=${encodeURIComponent(m)}`, { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) { ultimoError = `HTTP ${resp.status} consultando Proyección (${m})`; continue; }
        const data = await resp.json();
        (data.productos || []).forEach(p => { if (p.id) porId[p.id] = p.semaforo; });
        if (data.fecha_corte) fechaCorte = data.fecha_corte;
        ok = true;
      } catch(e) { ultimoError = e.message; }
    }
    if (ok) {
      SEMAFOROS = { porId, fecha_corte: fechaCorte, synced_at: new Date().toISOString(), error: ultimoError };
      console.log(`✓ Semáforos de Proyección: ${Object.keys(porId).length} productos, corte ${fechaCorte}`);
    } else {
      SEMAFOROS.error = ultimoError || 'No se pudo consultar la Proyección del dashboard';
      console.error('Semáforos Proyección:', SEMAFOROS.error);
    }
  } catch(e) { SEMAFOROS.error = e.message; console.error('Error semáforos Proyección:', e.message); }
}

// Catálogo de canje: productos con su semáforo de Proyección (cliente solo ve verdes)
function construirCatalogoCanje() {
  const lista = Object.entries(catalogoProductos)
    .filter(([id, info]) => {
      const n = (info.nombre||'').trim().toUpperCase();
      return info.nombre && !n.startsWith('PROMO') && !n.startsWith('LÍNEA') && !n.startsWith('LINEA');
    })
    .map(([id, info]) => {
      // Precio y foto: primero la web (PVP de cosetika.com, cruzado por SKU);
      // si el producto no está en la web, cae al precio del catálogo de Contifico.
      const woo = wooPorSku[(info.codigo||'').trim()] || null;
      return {
        id,
        nombre: info.nombre,
        marca: info.marca,
        precio: (woo && woo.precio > 0) ? woo.precio : info.precio,
        imagen: woo ? woo.imagen : null,
        precio_fuente: (woo && woo.precio > 0) ? 'web' : (info.precio > 0 ? 'contifico' : null),
        en_web: !!woo,
        // Sin dato en la Proyección → se trata como rojo (no canjeable), por seguridad
        semaforo: SEMAFOROS.porId[id] || 'rojo'
      };
    })
    .sort((a,b) => a.marca.localeCompare(b.marca) || a.nombre.localeCompare(b.nombre));
  return { fecha_corte: SEMAFOROS.fecha_corte, productos: lista };
}

// Regla de visibilidad para clientes: inventario VERDE + precio y foto de la WEB.
// (Pedido por Fernando: solo productos que están en cosetika.com, nada de Contifico solo.)
function esVisibleCliente(p) {
  return p.semaforo === 'verde' && p.precio > 0 && p.precio_fuente === 'web' && !!p.imagen;
}

// ─── SYNC DE COMPRAS: facturas de Contifico → recompensas_compras ────────────
let syncEnProceso = false;

async function sincronizarCompras(diasAtras = 3, clienteIdFiltro = null) {
  if (!API_KEY) return { ok:false, error:'Sin CONTIFICO_API_KEY' };
  if (syncEnProceso) return { ok:false, error:'Sync ya en proceso' };
  syncEnProceso = true;
  try {
    const params = clienteIdFiltro ? [clienteIdFiltro] : [];
    const rCli = await pool.query(
      `SELECT id, ruc, TO_CHAR(desde,'YYYY-MM-DD') AS desde FROM recompensas_clientes WHERE activo=true` +
      (clienteIdFiltro ? ' AND id=$1' : ''), params
    );
    const clientes = rCli.rows;
    if (!clientes.length) { syncEnProceso = false; return { ok:true, nuevos:0, msg:'Sin clientes activos' }; }
    // Cédula (10 dígitos) y RUC de persona natural (13 = cédula + '001') son la
    // MISMA persona: se indexa por ambas formas para que la factura cruce siempre,
    // sin importar con cuál se registró al cliente o cuál usó Contifico.
    const porRuc = {};
    clientes.forEach(c => {
      const id = c.ruc.trim();
      porRuc[id] = c;
      if (/^\d{10}$/.test(id)) porRuc[id + '001'] = c;
      if (/^\d{10}001$/.test(id)) porRuc[id.slice(0, 10)] = c;
    });

    // Rango de fechas: últimos N días; si es backfill de un cliente, desde su fecha "desde"
    const hoy = nowEC();
    let inicio = new Date(hoy); inicio.setDate(inicio.getDate() - diasAtras);
    if (clienteIdFiltro) {
      const [y,m,d] = clientes[0].desde.split('-').map(Number);
      const desdeD = new Date(y, m-1, d);
      if (desdeD < inicio) inicio = desdeD;
    }
    const fi = fmtDateEC(inicio), ff = fmtDateEC(hoy);

    let nuevos = 0, revisados = 0;
    const documentosVistos = new Set();
    let nextUrl = `https://api.contifico.com/sistema/api/v2/documento/?fecha_inicial=${fi}&fecha_final=${ff}&page_size=100`;
    let paginas = 0;
    while (nextUrl && paginas < 200) {
      const resp = await fetch(nextUrl, { headers: { 'Authorization': API_KEY, 'Accept': 'application/json' } });
      if (!resp.ok) break;
      const data = await resp.json();
      for (const d of (data.results || [])) {
        if (d.tipo_registro !== 'CLI') continue;
        if (d.anulado) continue;
        // SOLO facturas (FAC): Contifico registra además pedidos/pre-facturas de la
        // misma venta (ej. numeración 2026xxxxxxx) que duplicarían la recompensa.
        if (d.tipo_documento !== 'FAC') continue;
        const docKey = String(d.id || d.documento);
        if (documentosVistos.has(docKey)) continue;
        documentosVistos.add(docKey);
        const cliRuc = ((d.cliente?.ruc || d.cliente?.cedula) || '').trim();
        const cli = porRuc[cliRuc];
        if (!cli) continue;
        const fechaSQL = fechaDocASQL(d.fecha_emision);
        if (!fechaSQL || fechaSQL < cli.desde) continue; // solo compras desde la fecha de alta
        // Base de la recompensa: TOTAL CON IVA de la factura (columna "subtotal" de la
        // tabla guarda este monto base — el nombre quedó del diseño inicial sin IVA).
        const montoBase = Math.round(parseFloat(d.total || 0)*100)/100;
        if (montoBase <= 0) continue; // ej. la propia factura de un canje al 100% dcto.
        const recompensa = Math.round(montoBase * REGLA_PCT * 100)/100;
        revisados++;
        const r = await pool.query(
          `INSERT INTO recompensas_compras(cliente_id, documento_id, documento, fecha, subtotal, recompensa)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (cliente_id, documento_id) DO NOTHING`,
          [cli.id, docKey, d.documento || '', fechaSQL, montoBase, recompensa]
        );
        if (r.rowCount > 0) nuevos++;
      }
      nextUrl = data.next || null;
      paginas++;
    }
    console.log(`✓ Sync compras (${fi} → ${ff}): ${revisados} facturas de clientes del plan, ${nuevos} nuevas acreditadas`);
    syncEnProceso = false;
    return { ok:true, rango:`${fi} → ${ff}`, revisados, nuevos };
  } catch(e) {
    syncEnProceso = false;
    console.error('Error sync compras:', e.message);
    return { ok:false, error: e.message };
  }
}

// ─── SALDOS ──────────────────────────────────────────────────────────────────
async function resumenCliente(clienteId) {
  const rCli = await pool.query(
    `SELECT id, ruc, nombre, contacto, ciudad, usuario, password, email, TO_CHAR(desde,'YYYY-MM-DD') AS desde, activo
     FROM recompensas_clientes WHERE id=$1`, [clienteId]);
  if (!rCli.rows.length) return null;
  const rComp = await pool.query(
    `SELECT documento, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, subtotal, recompensa
     FROM recompensas_compras WHERE cliente_id=$1 ORDER BY fecha DESC, id DESC LIMIT 200`, [clienteId]);
  const rCanjes = await pool.query(
    `SELECT id, items, total, estado, TO_CHAR(created_at AT TIME ZONE 'America/Guayaquil','YYYY-MM-DD') AS fecha
     FROM recompensas_canjes WHERE cliente_id=$1 ORDER BY id DESC LIMIT 100`, [clienteId]);
  const rTot = await pool.query(
    `SELECT COALESCE((SELECT SUM(recompensa) FROM recompensas_compras WHERE cliente_id=$1),0) AS generado,
            COALESCE((SELECT SUM(subtotal) FROM recompensas_compras WHERE cliente_id=$1),0) AS compras,
            COALESCE((SELECT SUM(total) FROM recompensas_canjes WHERE cliente_id=$1 AND estado!='rechazado'),0) AS canjeado`,
    [clienteId]);
  const t = rTot.rows[0];
  const generado = Math.round(parseFloat(t.generado)*100)/100;
  const canjeado = Math.round(parseFloat(t.canjeado)*100)/100;
  return {
    cliente: rCli.rows[0],
    compras_total: Math.round(parseFloat(t.compras)*100)/100,
    saldo_generado: generado,
    saldo_canjeado: canjeado,
    saldo_disponible: Math.round((generado - canjeado)*100)/100,
    compras: rComp.rows.map(x => ({...x, subtotal: parseFloat(x.subtotal), recompensa: parseFloat(x.recompensa)})),
    canjes: rCanjes.rows.map(x => ({...x, total: parseFloat(x.total), items: JSON.parse(x.items||'[]')}))
  };
}

// ─── INIT DB (solo tablas nuevas recompensas_* — no toca las existentes) ─────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recompensas_clientes (
        id SERIAL PRIMARY KEY,
        ruc VARCHAR(20) UNIQUE NOT NULL,
        nombre VARCHAR(500) NOT NULL,
        contacto VARCHAR(255),
        ciudad VARCHAR(255),
        usuario VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        desde DATE NOT NULL DEFAULT CURRENT_DATE,
        activo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS recompensas_compras (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER NOT NULL REFERENCES recompensas_clientes(id) ON DELETE CASCADE,
        documento_id VARCHAR(100) NOT NULL,
        documento VARCHAR(100),
        fecha DATE NOT NULL,
        subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
        recompensa NUMERIC(12,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(cliente_id, documento_id)
      );
      CREATE INDEX IF NOT EXISTS idx_recomp_compras_cliente ON recompensas_compras(cliente_id);
      CREATE TABLE IF NOT EXISTS recompensas_canjes (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER NOT NULL REFERENCES recompensas_clientes(id) ON DELETE CASCADE,
        items TEXT NOT NULL,
        total NUMERIC(12,2) NOT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        created_at TIMESTAMP DEFAULT NOW(),
        resuelto_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_recomp_canjes_cliente ON recompensas_canjes(cliente_id);
      CREATE TABLE IF NOT EXISTS recompensas_permisos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER UNIQUE NOT NULL,
        nivel VARCHAR(10) NOT NULL DEFAULT 'ver', -- 'ver' | 'crear'
        actualizado_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE recompensas_permisos ADD COLUMN IF NOT EXISTS ver_claves BOOLEAN DEFAULT false;
      ALTER TABLE recompensas_clientes ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      CREATE TABLE IF NOT EXISTS recompensas_push (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(10) NOT NULL,      -- 'equipo' (admin y asesoras) | 'cliente'
        cliente_id INTEGER,
        nombre VARCHAR(255),
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT,
        auth TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✓ Tablas recompensas_* listas');
  } catch(e) { console.error('Error initDB:', e.message); }
}

initDB()
  .then(() => sincronizarCatalogo())
  .then(() => cargarSemaforos())
  .then(() => sincronizarWoo())
  .then(() => sincronizarCompras(3))
  .catch(e => console.error('Error init:', e.message));
setInterval(() => sincronizarCompras(1).catch(e=>console.error(e)), 5 * 60 * 1000);        // facturas del día cada 5 min
setInterval(() => sincronizarCompras(7).catch(e=>console.error(e)), 6 * 60 * 60 * 1000);   // repaso de la semana cada 6 h
setInterval(() => cargarSemaforos().catch(e=>console.error(e)), 15 * 60 * 1000);           // semáforo Proyección cada 15 min
setInterval(() => sincronizarCatalogo().catch(e=>console.error(e)), 24 * 60 * 60 * 1000);  // catálogo diario
setInterval(() => sincronizarWoo().catch(e=>console.error(e)), 6 * 60 * 60 * 1000);        // precios/fotos web cada 6 h

// ─── HTTP ────────────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.svg':'image/svg+xml' };

function bodyJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, {'Content-Type':'application/json'});
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  const urlPath = urlObj.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  try {

  // ── LOGIN: equipo COSÉTIKA (tabla usuarios del dashboard) o cliente del plan ──
  // admin → acceso total · asesora/jefa con permiso → 'ver' o 'crear' (tab Equipo)
  if (urlPath === '/api/login' && req.method === 'POST') {
    const { usuario, password } = await bodyJSON(req);
    // 1) equipo del dashboard (misma clave que usan en el panel de ventas)
    try {
      const rU = await pool.query(
        `SELECT id, nombre, rol FROM usuarios WHERE usuario=$1 AND password=$2 AND activo=true`,
        [usuario, password]);
      if (rU.rows.length) {
        const u = rU.rows[0];
        if (u.rol === 'admin') { json(res, 200, { ok:true, tipo:'admin', nombre: u.nombre }); return; }
        const rP = await pool.query('SELECT nivel, ver_claves FROM recompensas_permisos WHERE usuario_id=$1', [u.id]);
        if (rP.rows.length) { json(res, 200, { ok:true, tipo:'staff', nivel: rP.rows[0].nivel, ver_claves: !!rP.rows[0].ver_claves, nombre: u.nombre }); return; }
        json(res, 401, { ok:false, error:'Tu usuario aún no tiene acceso al Plan de Recompensas — pídeselo a Fernando' });
        return;
      }
    } catch(e) { /* tabla usuarios podría no existir — seguir al cliente */ }
    // 2) cliente del plan
    const rC = await pool.query(
      `SELECT id, nombre, contacto FROM recompensas_clientes WHERE usuario=$1 AND password=$2 AND activo=true`,
      [usuario, password]);
    if (rC.rows.length) { json(res, 200, { ok:true, tipo:'cliente', cliente_id: rC.rows[0].id, nombre: rC.rows[0].nombre, contacto: rC.rows[0].contacto }); return; }
    json(res, 401, { ok:false, error:'Usuario o contraseña incorrectos' });
    return;
  }

  // ── PUSH: clave pública y suscripción de dispositivos ──
  if (urlPath === '/api/push/vapid-key' && req.method === 'GET') {
    json(res, 200, { publicKey: VAPID_PUBLIC_KEY });
    return;
  }
  if (urlPath === '/api/push/subscribe' && req.method === 'POST') {
    const { subscription, tipo, cliente_id, nombre } = await bodyJSON(req);
    if (!subscription || !subscription.endpoint || !['equipo','cliente'].includes(tipo)) { json(res, 400, { ok:false, error:'Datos inválidos' }); return; }
    await pool.query(
      `INSERT INTO recompensas_push(tipo, cliente_id, nombre, endpoint, p256dh, auth)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(endpoint) DO UPDATE SET tipo=$1, cliente_id=$2, nombre=$3, p256dh=$5, auth=$6`,
      [tipo, cliente_id||null, nombre||'', subscription.endpoint, subscription.keys?.p256dh||null, subscription.keys?.auth||null]);
    json(res, 200, { ok:true });
    return;
  }

  // ── ADMIN: equipo con acceso a Recompensas ──
  if (urlPath === '/api/admin/equipo' && req.method === 'GET') {
    const r = await pool.query(`
      SELECT u.id, u.nombre, u.usuario, u.rol, p.nivel, p.ver_claves
      FROM usuarios u
      LEFT JOIN recompensas_permisos p ON p.usuario_id = u.id
      WHERE u.activo=true AND u.rol != 'admin'
      ORDER BY u.nombre`);
    json(res, 200, r.rows.map(x => ({ ...x, nivel: x.nivel || 'ninguno', ver_claves: !!x.ver_claves })));
    return;
  }
  if (urlPath === '/api/admin/equipo' && req.method === 'POST') {
    const { usuario_id, nivel, ver_claves } = await bodyJSON(req);
    if (!usuario_id) { json(res, 400, { ok:false, error:'Datos inválidos' }); return; }
    if (nivel !== undefined) {
      if (!['ninguno','ver','crear'].includes(nivel)) { json(res, 400, { ok:false, error:'Nivel inválido' }); return; }
      if (nivel === 'ninguno') {
        await pool.query('DELETE FROM recompensas_permisos WHERE usuario_id=$1', [usuario_id]);
      } else {
        await pool.query(
          `INSERT INTO recompensas_permisos(usuario_id, nivel) VALUES($1,$2)
           ON CONFLICT(usuario_id) DO UPDATE SET nivel=$2, actualizado_at=NOW()`,
          [usuario_id, nivel]);
      }
    }
    if (ver_claves !== undefined) {
      // Si aún no tiene fila de permiso, se crea con nivel 'ver' por defecto
      await pool.query(
        `INSERT INTO recompensas_permisos(usuario_id, nivel, ver_claves) VALUES($1,'ver',$2)
         ON CONFLICT(usuario_id) DO UPDATE SET ver_claves=$2, actualizado_at=NOW()`,
        [usuario_id, !!ver_claves]);
    }
    json(res, 200, { ok:true });
    return;
  }

  // ── ADMIN: lista de clientes con saldos ──
  if (urlPath === '/api/admin/clientes' && req.method === 'GET') {
    const r = await pool.query(`
      SELECT c.id, c.ruc, c.nombre, c.contacto, c.ciudad, c.usuario, c.activo,
             TO_CHAR(c.desde,'YYYY-MM-DD') AS desde,
             COALESCE(SUM(co.subtotal),0) AS compras,
             COALESCE(SUM(co.recompensa),0) AS generado,
             COUNT(co.id) AS num_facturas,
             COALESCE((SELECT SUM(total) FROM recompensas_canjes k WHERE k.cliente_id=c.id AND k.estado!='rechazado'),0) AS canjeado
      FROM recompensas_clientes c
      LEFT JOIN recompensas_compras co ON co.cliente_id=c.id
      GROUP BY c.id ORDER BY c.nombre`);
    json(res, 200, r.rows.map(x => ({
      ...x,
      compras: parseFloat(x.compras), generado: parseFloat(x.generado),
      canjeado: parseFloat(x.canjeado), num_facturas: parseInt(x.num_facturas),
      saldo: Math.round((parseFloat(x.generado)-parseFloat(x.canjeado))*100)/100
    })));
    return;
  }

  // ── ADMIN: crear cliente (dispara backfill desde su fecha "desde") ──
  if (urlPath === '/api/admin/clientes' && req.method === 'POST') {
    const { ruc, nombre, contacto, ciudad, usuario, password, desde, email } = await bodyJSON(req);
    if (!ruc || !nombre || !usuario || !password) { json(res, 400, { ok:false, error:'Faltan ruc, nombre, usuario o contraseña' }); return; }
    if (!/^\d{10}(\d{3})?$/.test(ruc.trim())) { json(res, 400, { ok:false, error:'La cédula debe tener 10 dígitos o el RUC 13' }); return; }
    try {
      const r = await pool.query(
        `INSERT INTO recompensas_clientes(ruc, nombre, contacto, ciudad, usuario, password, desde, email)
         VALUES($1,$2,$3,$4,$5,$6, COALESCE($7::date, CURRENT_DATE), $8) RETURNING id`,
        [ruc.trim(), nombre.trim(), contacto||null, ciudad||null, usuario.trim(), password, desde||null, (email||'').trim()||null]);
      const nuevoId = r.rows[0].id;
      // Backfill en background desde su fecha de inicio (si es hoy, casi instantáneo)
      sincronizarCompras(0, nuevoId).catch(e=>console.error(e));
      json(res, 200, { ok:true, id: nuevoId });
    } catch(e) {
      if ((e.message||'').includes('duplicate')) json(res, 400, { ok:false, error:'Ya existe un cliente con ese RUC o ese usuario' });
      else json(res, 500, { ok:false, error:e.message });
    }
    return;
  }

  // ── ADMIN: editar cliente (activo, password, contacto, ciudad) ──
  const mCli = urlPath.match(/^\/api\/admin\/clientes\/(\d+)$/);
  if (mCli && req.method === 'PUT') {
    const body = await bodyJSON(req);
    const permitidas = ['nombre','contacto','ciudad','password','activo','ruc','desde','email'];
    const cols = Object.keys(body).filter(k => permitidas.includes(k));
    if (cols.length) {
      const sets = cols.map((k,i)=>`${k}=$${i+1}`).join(',');
      await pool.query(`UPDATE recompensas_clientes SET ${sets} WHERE id=$${cols.length+1}`, [...cols.map(k=>body[k]), mCli[1]]);
    }
    json(res, 200, { ok:true });
    return;
  }

  // ── ADMIN: detalle de un cliente ──
  const mDet = urlPath.match(/^\/api\/admin\/clientes\/(\d+)\/resumen$/);
  if (mDet && req.method === 'GET') {
    const resumen = await resumenCliente(parseInt(mDet[1]));
    if (!resumen) { json(res, 404, { ok:false, error:'Cliente no encontrado' }); return; }
    json(res, 200, resumen);
    return;
  }

  // ── ADMIN: canjes (todos o por estado) ──
  if (urlPath === '/api/admin/canjes' && req.method === 'GET') {
    const estado = urlObj.searchParams.get('estado');
    const r = estado
      ? await pool.query(`SELECT k.*, c.nombre AS cliente_nombre, TO_CHAR(k.created_at AT TIME ZONE 'America/Guayaquil','YYYY-MM-DD') AS fecha FROM recompensas_canjes k JOIN recompensas_clientes c ON c.id=k.cliente_id WHERE k.estado=$1 ORDER BY k.id DESC`, [estado])
      : await pool.query(`SELECT k.*, c.nombre AS cliente_nombre, TO_CHAR(k.created_at AT TIME ZONE 'America/Guayaquil','YYYY-MM-DD') AS fecha FROM recompensas_canjes k JOIN recompensas_clientes c ON c.id=k.cliente_id ORDER BY k.id DESC LIMIT 200`);
    json(res, 200, r.rows.map(x => ({...x, total: parseFloat(x.total), items: JSON.parse(x.items||'[]')})));
    return;
  }

  // ── ADMIN: resolver canje (aprobar / rechazar / entregar) ──
  const mCanje = urlPath.match(/^\/api\/admin\/canjes\/(\d+)\/resolver$/);
  if (mCanje && req.method === 'POST') {
    const { estado } = await bodyJSON(req);
    if (!['aprobado','rechazado','entregado'].includes(estado)) { json(res, 400, { ok:false, error:'Estado inválido' }); return; }
    await pool.query(`UPDATE recompensas_canjes SET estado=$1, resuelto_at=NOW() WHERE id=$2`, [estado, mCanje[1]]);
    // Avisar al cliente cuando se aprueba (push + correo si tiene email registrado)
    if (estado === 'aprobado') {
      try {
        const rk = await pool.query(
          `SELECT k.total, k.items, c.id AS cliente_id, c.nombre, c.email
           FROM recompensas_canjes k JOIN recompensas_clientes c ON c.id=k.cliente_id WHERE k.id=$1`, [mCanje[1]]);
        if (rk.rows.length) {
          const k = rk.rows[0];
          pushCliente(k.cliente_id, {
            title: '🎉 ¡Tu canje fue aprobado!',
            body: `Tus productos ($${parseFloat(k.total).toFixed(2)}) llegarán gratis con tu próximo pedido COSÉTIKA`,
            tag: 'canje-aprobado-' + mCanje[1], url: '/'
          }).catch(()=>{});
          if (k.email) {
            const items = JSON.parse(k.items||'[]');
            enviarCorreo([k.email], '🎉 Tu canje COSÉTIKA fue aprobado',
              htmlCorreo('¡Tu canje fue aprobado!', `<p>Hola <b>${k.nombre}</b>, aprobamos tu canje:</p>${htmlItemsCanje(items, parseFloat(k.total))}<p>Tus productos llegarán <b>gratis junto con tu próximo pedido</b>. 💛</p>`)
            ).catch(()=>{});
          }
        }
      } catch(e) { console.error('Error avisando canje aprobado:', e.message); }
    }
    json(res, 200, { ok:true });
    return;
  }

  // ── ADMIN: forzar sync de compras ──
  if (urlPath === '/api/admin/sync' && req.method === 'GET') {
    const dias = parseInt(urlObj.searchParams.get('dias')) || 3;
    const resultado = await sincronizarCompras(dias);
    json(res, 200, resultado);
    return;
  }

  // ── ADMIN: recalcular TODO desde cero (usar tras un cambio de regla, ej.
  // el paso de "10% sin IVA" a "10% con IVA"). Borra las compras acreditadas y
  // las vuelve a traer de Contifico desde la fecha "desde" de cada cliente.
  // Los canjes NO se tocan.
  if (urlPath === '/api/admin/recalcular' && req.method === 'GET') {
    const rCli = await pool.query('SELECT id, nombre FROM recompensas_clientes WHERE activo=true ORDER BY id');
    const resultados = [];
    for (const c of rCli.rows) {
      await pool.query('DELETE FROM recompensas_compras WHERE cliente_id=$1', [c.id]);
      const r = await sincronizarCompras(0, c.id);
      resultados.push({ cliente: c.nombre, ...r });
    }
    json(res, 200, { ok:true, clientes: resultados.length, resultados });
    return;
  }

  // ── CATÁLOGO: cliente ve solo VERDE con precio; admin (?todos=1) ve todo ──
  if (urlPath === '/api/catalogo' && req.method === 'GET') {
    const todos = urlObj.searchParams.get('todos') === '1';
    const { fecha_corte, productos } = construirCatalogoCanje();
    // En ambas vistas solo existen los productos que están en la página web:
    // admin ve todos los de la web (con su estado Visible/Oculto según inventario),
    // el cliente únicamente los visibles. Lo que está solo en Contifico no aparece.
    const soloWeb = productos.filter(p => p.en_web);
    const lista = todos
      ? soloWeb.map(p => ({ ...p, visible: esVisibleCliente(p) }))
      : soloWeb.filter(esVisibleCliente);
    json(res, 200, {
      ok: true,
      fecha_corte,
      catalogo_actualizado: catalogoSyncedAt,
      total: lista.length,
      productos: lista
    });
    return;
  }

  // ── CLIENTE: resumen (saldo, compras, canjes) ──
  const mRes = urlPath.match(/^\/api\/cliente\/(\d+)\/resumen$/);
  if (mRes && req.method === 'GET') {
    const resumen = await resumenCliente(parseInt(mRes[1]));
    if (!resumen) { json(res, 404, { ok:false, error:'Cliente no encontrado' }); return; }
    delete resumen.cliente.usuario;  // no exponer credenciales al lado cliente
    delete resumen.cliente.password;
    json(res, 200, resumen);
    return;
  }

  // ── CLIENTE: solicitar canje (validación de saldo y precios EN SERVIDOR) ──
  const mSol = urlPath.match(/^\/api\/cliente\/(\d+)\/canjes$/);
  if (mSol && req.method === 'POST') {
    const clienteId = parseInt(mSol[1]);
    const { items } = await bodyJSON(req); // [{id, qty}]
    if (!Array.isArray(items) || !items.length) { json(res, 400, { ok:false, error:'El canje está vacío' }); return; }
    const { productos } = construirCatalogoCanje();
    const disponibles = {};
    productos.filter(esVisibleCliente).forEach(p => { disponibles[p.id] = p; });
    const itemsValidados = [];
    let total = 0;
    for (const it of items) {
      const p = disponibles[it.id];
      const qty = parseInt(it.qty) || 0;
      if (!p) { json(res, 400, { ok:false, error:'Un producto ya no está disponible para canje. Refresca el catálogo.' }); return; }
      if (qty < 1 || qty > 50) { json(res, 400, { ok:false, error:'Cantidad inválida' }); return; }
      itemsValidados.push({ id: p.id, nombre: p.nombre, marca: p.marca, precio: p.precio, qty });
      total += p.precio * qty;
    }
    total = Math.round(total*100)/100;
    // Saldo con verificación en servidor
    const resumen = await resumenCliente(clienteId);
    if (!resumen) { json(res, 404, { ok:false, error:'Cliente no encontrado' }); return; }
    if (total > resumen.saldo_disponible) {
      json(res, 400, { ok:false, error:`Saldo insuficiente: tienes $${resumen.saldo_disponible.toFixed(2)} y el canje suma $${total.toFixed(2)}` });
      return;
    }
    const r = await pool.query(
      `INSERT INTO recompensas_canjes(cliente_id, items, total) VALUES($1,$2,$3) RETURNING id`,
      [clienteId, JSON.stringify(itemsValidados), total]);
    // Avisar al equipo COSÉTIKA (push + correo si está configurado) — sin bloquear la respuesta
    const resumenItems = itemsValidados.map(it=>`${it.qty}× ${it.nombre}`).join(', ');
    pushEquipo({
      title: `🎁 Canje de ${resumen.cliente.nombre} · $${total.toFixed(2)}`,
      body: resumenItems.slice(0, 120) + ' — entra a aprobarlo',
      tag: 'canje-' + r.rows[0].id, url: '/'
    }).catch(()=>{});
    if (MAIL_EQUIPO.length) {
      enviarCorreo(MAIL_EQUIPO, `Nueva solicitud de canje — ${resumen.cliente.nombre} ($${total.toFixed(2)})`,
        htmlCorreo('Nueva solicitud de canje', `<p><b>${resumen.cliente.nombre}</b> solicitó un canje:</p>${htmlItemsCanje(itemsValidados, total)}<p>Entra a la app para aprobarlo o rechazarlo.</p>`)
      ).catch(()=>{});
    }
    json(res, 200, { ok:true, id: r.rows[0].id, total });
    return;
  }

  // ── ADMIN: forzar sync de precios/fotos de la web ──
  if (urlPath === '/api/admin/sync-woo' && req.method === 'GET') {
    await sincronizarWoo();
    json(res, 200, {
      ok: !wooUltimoError,
      productos_web: Object.keys(wooPorSku).length,
      synced_at: wooSyncedAt,
      error: wooUltimoError
    });
    return;
  }

  // ── DEBUG: campos crudos del producto de Contifico (para ajustar el precio) ──
  if (urlPath === '/api/debug/producto-campos' && req.method === 'GET') {
    json(res, 200, {
      campos: ejemploProductoCrudo ? Object.keys(ejemploProductoCrudo) : [],
      ejemplo: ejemploProductoCrudo,
      productos_con_precio: Object.values(catalogoProductos).filter(x=>x.precio>0).length,
      productos_total: Object.keys(catalogoProductos).length
    });
    return;
  }

  // ── ESTADO GENERAL ──
  if (urlPath === '/api/estado' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      catalogo: { total: Object.keys(catalogoProductos).length, synced_at: catalogoSyncedAt },
      web: { productos: Object.keys(wooPorSku).length, synced_at: wooSyncedAt, error: wooUltimoError },
      proyeccion: { productos: Object.keys(SEMAFOROS.porId).length, fecha_corte: SEMAFOROS.fecha_corte, synced_at: SEMAFOROS.synced_at, error: SEMAFOROS.error },
      regla: '10% del total con IVA · precios PVP de cosetika.com · semáforo del panel Proyección'
    });
    return;
  }

  } catch(e) {
    json(res, 500, { ok:false, error: e.message });
    return;
  }

  // ── STATIC ──
  const filePath = urlPath === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
    if (ext === '.html' || ext === '.js') headers['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(200, {'Content-Type':'text/html','Cache-Control':'no-cache, must-revalidate'});
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Cosétika Recompensas corriendo en puerto ${PORT}`));
