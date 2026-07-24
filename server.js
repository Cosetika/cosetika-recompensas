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

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CONTIFICO_API_KEY || '';
const REGLA_PCT = 0.10; // 10% exacto sobre el TOTAL CON IVA de la factura
// (los precios del catálogo de canje son PVP con IVA, así que la base también lo es)

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
    const porRuc = {};
    clientes.forEach(c => { porRuc[c.ruc.trim()] = c; });

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
        // Mismos filtros que el dashboard (generarDataJson)
        if (d.tipo_registro !== 'CLI') continue;
        if (d.anulado) continue;
        if (['NC','COT','PRO'].includes(d.tipo_documento)) continue;
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
    `SELECT id, ruc, nombre, contacto, ciudad, usuario, password, TO_CHAR(desde,'YYYY-MM-DD') AS desde, activo
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
setInterval(() => sincronizarCompras(3).catch(e=>console.error(e)), 30 * 60 * 1000);       // compras cada 30 min
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
        const rP = await pool.query('SELECT nivel FROM recompensas_permisos WHERE usuario_id=$1', [u.id]);
        if (rP.rows.length) { json(res, 200, { ok:true, tipo:'staff', nivel: rP.rows[0].nivel, nombre: u.nombre }); return; }
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

  // ── ADMIN: equipo con acceso a Recompensas ──
  if (urlPath === '/api/admin/equipo' && req.method === 'GET') {
    const r = await pool.query(`
      SELECT u.id, u.nombre, u.usuario, u.rol, p.nivel
      FROM usuarios u
      LEFT JOIN recompensas_permisos p ON p.usuario_id = u.id
      WHERE u.activo=true AND u.rol != 'admin'
      ORDER BY u.nombre`);
    json(res, 200, r.rows.map(x => ({ ...x, nivel: x.nivel || 'ninguno' })));
    return;
  }
  if (urlPath === '/api/admin/equipo' && req.method === 'POST') {
    const { usuario_id, nivel } = await bodyJSON(req);
    if (!usuario_id || !['ninguno','ver','crear'].includes(nivel)) { json(res, 400, { ok:false, error:'Datos inválidos' }); return; }
    if (nivel === 'ninguno') {
      await pool.query('DELETE FROM recompensas_permisos WHERE usuario_id=$1', [usuario_id]);
    } else {
      await pool.query(
        `INSERT INTO recompensas_permisos(usuario_id, nivel) VALUES($1,$2)
         ON CONFLICT(usuario_id) DO UPDATE SET nivel=$2, actualizado_at=NOW()`,
        [usuario_id, nivel]);
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
    const { ruc, nombre, contacto, ciudad, usuario, password, desde } = await bodyJSON(req);
    if (!ruc || !nombre || !usuario || !password) { json(res, 400, { ok:false, error:'Faltan ruc, nombre, usuario o contraseña' }); return; }
    if (!/^\d{10}(\d{3})?$/.test(ruc.trim())) { json(res, 400, { ok:false, error:'La cédula debe tener 10 dígitos o el RUC 13' }); return; }
    try {
      const r = await pool.query(
        `INSERT INTO recompensas_clientes(ruc, nombre, contacto, ciudad, usuario, password, desde)
         VALUES($1,$2,$3,$4,$5,$6, COALESCE($7::date, CURRENT_DATE)) RETURNING id`,
        [ruc.trim(), nombre.trim(), contacto||null, ciudad||null, usuario.trim(), password, desde||null]);
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
    const permitidas = ['nombre','contacto','ciudad','password','activo'];
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
