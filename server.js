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
const REGLA_PCT = 0.10; // 10% exacto sobre subtotal sin IVA

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
      const resp = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'CosetikaRecompensas/1.0' } });
      if (!resp.ok) { wooUltimoError = `HTTP ${resp.status} al consultar productos`; break; }
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

// ─── DATA DEL DASHBOARD (misma BD): ventas e inventario para el semáforo ─────
let VENTAS_CACHE = null;      // ventas_data (JSON grande del dashboard)
let INVENTARIO_CACHE = null;  // inventario_data { fecha_corte, productos:{id:{cantidad,...}} }

async function cargarDataDashboard() {
  try {
    const rV = await pool.query("SELECT datos FROM ventas_data ORDER BY actualizado_at DESC LIMIT 1");
    if (rV.rows.length) VENTAS_CACHE = JSON.parse(rV.rows[0].datos);
    const rI = await pool.query("SELECT datos FROM inventario_data ORDER BY actualizado_at DESC LIMIT 1");
    if (rI.rows.length) INVENTARIO_CACHE = JSON.parse(rI.rows[0].datos);
    console.log(`✓ Data dashboard: ventas ${VENTAS_CACHE?'OK':'—'} · inventario ${INVENTARIO_CACHE?('corte '+INVENTARIO_CACHE.fecha_corte):'—'}`);
  } catch(e) { console.error('Error cargando data del dashboard:', e.message); }
}

// Reglas de semáforo por marca — MISMAS que el módulo Inventario del dashboard
const INVENTARIO_REGLAS_MARCA = {
  'BIOSKIN':   { minimo: 1, amarillo: 1.5 },
  'ZIAJA':     { minimo: 3, amarillo: 4 },
  'ZIAJA PRO': { minimo: 3, amarillo: 4 },
  'ERAYBA':    { minimo: 3, amarillo: 4 }
};
function calcularSemaforo(marca, coberturaMeses) {
  const r = INVENTARIO_REGLAS_MARCA[marca] || { minimo: 3, amarillo: 4 };
  if (coberturaMeses < r.minimo) return 'rojo';
  if (coberturaMeses < r.amarillo) return 'amarillo';
  return 'verde';
}

// Rotación mensual: promedio de los 3 meses cerrados antes del corte (igual que dashboard)
function calcularRotacionMensual(fechaCorte) {
  const [anioCorte, mesCorte] = (fechaCorte||'').split('-').map(Number);
  if (!anioCorte) return {};
  const meses3 = [];
  let a = anioCorte, m = mesCorte;
  for (let i = 0; i < 3; i++) { m -= 1; if (m === 0) { m = 12; a -= 1; } meses3.push({ anio: a, mes: m }); }
  const acumulado = {};
  Object.values(VENTAS_CACHE||{}).forEach(clientes => {
    (clientes||[]).forEach(cli => {
      (cli.productos_mes||[]).forEach(pm => {
        if (!meses3.some(x => x.anio===pm.anio && x.mes===pm.mes)) return;
        const key = pm.id || pm.nombre;
        acumulado[key] = (acumulado[key]||0) + (pm.cantidad||0);
      });
    });
  });
  const rot = {};
  Object.entries(acumulado).forEach(([id, total]) => { rot[id] = total/3; });
  return rot;
}

// Catálogo de canje: todos los productos con su semáforo (el cliente solo ve verdes)
function construirCatalogoCanje() {
  if (!INVENTARIO_CACHE) return { fecha_corte: null, productos: [] };
  const rotacion = calcularRotacionMensual(INVENTARIO_CACHE.fecha_corte);
  const lista = Object.entries(catalogoProductos)
    .filter(([id, info]) => {
      const n = (info.nombre||'').trim().toUpperCase();
      return info.nombre && !n.startsWith('PROMO') && !n.startsWith('LÍNEA') && !n.startsWith('LINEA');
    })
    .map(([id, info]) => {
      const inv = INVENTARIO_CACHE.productos[id];
      const stock = inv ? inv.cantidad : 0;
      const rotMensual = rotacion[id] || 0;
      const cobertura = rotMensual > 0 ? stock/rotMensual : (stock > 0 ? 99 : 0);
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
        stock: Math.round(stock),
        semaforo: calcularSemaforo(info.marca, cobertura)
      };
    })
    .sort((a,b) => a.marca.localeCompare(b.marca) || a.nombre.localeCompare(b.nombre));
  return { fecha_corte: INVENTARIO_CACHE.fecha_corte, productos: lista };
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
        const subtotal = Math.round(parseFloat(d.subtotal || d.subtotal_15 || d.subtotal_12 || (d.total/1.15) || 0)*100)/100;
        if (subtotal <= 0) continue; // ej. la propia factura de un canje al 100% dcto.
        const recompensa = Math.round(subtotal * REGLA_PCT * 100)/100;
        revisados++;
        const r = await pool.query(
          `INSERT INTO recompensas_compras(cliente_id, documento_id, documento, fecha, subtotal, recompensa)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (cliente_id, documento_id) DO NOTHING`,
          [cli.id, docKey, d.documento || '', fechaSQL, subtotal, recompensa]
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
    `SELECT id, ruc, nombre, contacto, ciudad, usuario, TO_CHAR(desde,'YYYY-MM-DD') AS desde, activo
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
    `);
    console.log('✓ Tablas recompensas_* listas');
  } catch(e) { console.error('Error initDB:', e.message); }
}

initDB()
  .then(() => cargarDataDashboard())
  .then(() => sincronizarCatalogo())
  .then(() => sincronizarWoo())
  .then(() => sincronizarCompras(3))
  .catch(e => console.error('Error init:', e.message));
setInterval(() => sincronizarCompras(3).catch(e=>console.error(e)), 30 * 60 * 1000);       // compras cada 30 min
setInterval(() => cargarDataDashboard().catch(e=>console.error(e)), 60 * 60 * 1000);       // semáforo cada hora
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

  // ── LOGIN: admin (tabla usuarios del dashboard, rol admin) o cliente ──
  if (urlPath === '/api/login' && req.method === 'POST') {
    const { usuario, password } = await bodyJSON(req);
    // 1) admin del dashboard
    try {
      const rA = await pool.query(
        `SELECT id, nombre FROM usuarios WHERE usuario=$1 AND password=$2 AND rol='admin' AND activo=true`,
        [usuario, password]);
      if (rA.rows.length) { json(res, 200, { ok:true, tipo:'admin', nombre: rA.rows[0].nombre }); return; }
    } catch(e) { /* tabla usuarios podría no existir en otra BD — seguir al cliente */ }
    // 2) cliente del plan
    const rC = await pool.query(
      `SELECT id, nombre, contacto FROM recompensas_clientes WHERE usuario=$1 AND password=$2 AND activo=true`,
      [usuario, password]);
    if (rC.rows.length) { json(res, 200, { ok:true, tipo:'cliente', cliente_id: rC.rows[0].id, nombre: rC.rows[0].nombre, contacto: rC.rows[0].contacto }); return; }
    json(res, 401, { ok:false, error:'Usuario o contraseña incorrectos' });
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

  // ── CATÁLOGO: cliente ve solo VERDE con precio; admin (?todos=1) ve todo ──
  if (urlPath === '/api/catalogo' && req.method === 'GET') {
    const todos = urlObj.searchParams.get('todos') === '1';
    const { fecha_corte, productos } = construirCatalogoCanje();
    const lista = todos ? productos : productos.filter(p => p.semaforo === 'verde' && p.precio > 0);
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
    delete resumen.cliente.usuario; // no exponer credenciales
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
    productos.filter(p => p.semaforo==='verde' && p.precio>0).forEach(p => { disponibles[p.id] = p; });
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
      inventario_corte: INVENTARIO_CACHE?.fecha_corte || null,
      ventas_data: !!VENTAS_CACHE,
      regla: '10% del subtotal sin IVA · precios PVP de cosetika.com'
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
