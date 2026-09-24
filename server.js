require('dotenv').config();
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'apex-admin-2026';
const ADMIN_COOKIE = 'apex_admin_token';
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');
const PAYMENTS_ENABLED = String(process.env.PAYMENTS_ENABLED || 'true').toLowerCase() !== 'false';

const publicDir = path.join(__dirname, 'public');

// Paystack webhook - must run BEFORE express.json() so we get the raw body for signature checking
app.post('/api/webhook/paystack', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
  const sigBuf = Buffer.from(sig || '', 'utf8');
  const hashBuf = Buffer.from(hash, 'utf8');
  const ok = sigBuf.length === hashBuf.length && crypto.timingSafeEqual(sigBuf, hashBuf);
  if (!ok) return res.status(401).send('Bad signature');

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch (e) { return res.sendStatus(400); }

  if (event.event === 'charge.success' && event.data && event.data.reference) {
    const order = db.getOrderByPaystackRef(event.data.reference);
    if (order && event.data.status === 'success') db.setOrderStatus(order.id, 'paid');
  }
  res.sendStatus(200);
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(publicDir));

// Public shop contact details (used to notify the shop via wa.me from the front-end)
app.get('/api/config', (req, res) => {
  res.json({
    shopWhatsapp: process.env.SHOP_WHATSAPP || '',
    shopPhone: process.env.SHOP_PHONE || '',
    paymentsEnabled: PAYMENTS_ENABLED
  });
});

function naira(kobo) {
  return '\u20A6' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

async function paystackInit(reference, email, amountKobo, callbackUrl) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: amountKobo, reference, callback_url: callbackUrl })
  });
  return res.json();
}

async function paystackVerify(reference) {
  const res = await fetch('https://api.paystack.co/transaction/verify/' + reference, {
    headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET }
  });
  return res.json();
}

const isAdmin = (req, res, next) => {
  if (req.cookies[ADMIN_COOKIE] === ADMIN_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// ---------- PRODUCT CATALOG (editable via admin) ----------

const PRODUCTS_FILE = path.join(publicDir, 'data', 'products.js');

function loadProducts() {
  const raw = fs.readFileSync(PRODUCTS_FILE, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(raw, sandbox, { timeout: 1000 });
  if (!sandbox.window.APEX_PRODUCTS) throw new Error('catalog file malformed');
  return sandbox.window.APEX_PRODUCTS;
}

function saveProducts(catalog) {
  const out = 'window.APEX_PRODUCTS = ' + JSON.stringify(catalog, null, 2) + ';';
  const tmp = PRODUCTS_FILE + '.tmp';
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, PRODUCTS_FILE);
}

function findCatalogItem(catalog, id) {
  const vi = catalog.vehicles.findIndex(v => v.id === id);
  if (vi > -1) return { kind: 'vehicle', index: vi };
  const pi = catalog.parts.findIndex(p => p.id === id);
  if (pi > -1) return { kind: 'parts', index: pi };
  return null;
}

// Public read of the catalog (single source of truth for all pages)
app.get('/api/products', (req, res) => {
  try { res.json(loadProducts()); } catch (e) { res.status(500).json({ error: 'Catalog unavailable.' }); }
});

// Admin: add a product. kind = 'vehicle' | 'parts'
app.post('/api/admin/products', isAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const kind = b.kind === 'parts' ? 'parts' : 'vehicle';
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required.' });
    const catalog = loadProducts();
    const id = (kind === 'vehicle' ? 'v' : 'p') + '-' + Date.now().toString(36);
    const item = { id, name: String(b.name).trim() };
    if (kind === 'vehicle') {
      item.category = String(b.category || 'Vehicle').trim();
      item.icon = String(b.icon || 'fa-motorcycle').trim();
      item.price = Math.max(0, Number(b.price) || 0);
      item.priceNote = item.price > 0 ? String(b.priceNote || 'Base price').trim() : 'Price on request';
      item.img = String(b.img || '').trim();
      item.tagline = String(b.tagline || '').trim() || 'Ask about this unit via quote.';
      item.features = Array.isArray(b.features) ? b.features.map(String).filter(x => x.trim()).map(x => x.trim()) : [];
      if (!item.features.length) item.features = ['Delivery nationwide'];
      catalog.vehicles.push(item);
    } else {
      item.note = String(b.note || 'In stock').trim();
      item.icon = String(b.icon || 'fa-gear').trim();
      item.img = String(b.img || '').trim();
      catalog.parts.push(item);
    }
    saveProducts(catalog);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: 'Failed to add product.' }); }
});

// Admin: update an existing product (partial update)
app.put('/api/admin/products/:id', isAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const catalog = loadProducts();
    const hit = findCatalogItem(catalog, String(req.params.id));
    if (!hit) return res.status(404).json({ error: 'Product not found.' });
    const item = hit.kind === 'vehicle' ? catalog.vehicles[hit.index] : catalog.parts[hit.index];
    if (b.name !== undefined) item.name = String(b.name).trim();
    if (b.icon !== undefined) item.icon = String(b.icon).trim();
    if (b.img !== undefined) item.img = String(b.img).trim();
    if (hit.kind === 'vehicle') {
      if (b.category !== undefined) item.category = String(b.category).trim();
      if (b.tagline !== undefined) item.tagline = String(b.tagline).trim();
      if (b.price !== undefined) {
        item.price = Math.max(0, Number(b.price) || 0);
        item.priceNote = b.priceNote !== undefined ? String(b.priceNote).trim() : (item.price > 0 ? 'Base price' : 'Price on request');
      }
      if (b.features !== undefined) item.features = Array.isArray(b.features) ? b.features.map(String).filter(x => x.trim()).map(x => x.trim()) : [];
    } else {
      if (b.note !== undefined) item.note = String(b.note).trim();
    }
    saveProducts(catalog);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: 'Failed to update product.' }); }
});

// Admin: delete a product
app.delete('/api/admin/products/:id', isAdmin, (req, res) => {
  try {
    const catalog = loadProducts();
    const hit = findCatalogItem(catalog, String(req.params.id));
    if (!hit) return res.status(404).json({ error: 'Product not found.' });
    if (hit.kind === 'vehicle') catalog.vehicles.splice(hit.index, 1);
    else catalog.parts.splice(hit.index, 1);
    saveProducts(catalog);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete product.' }); }
});

// ---------- PUBLIC ----------

// Quote request (hero form / parts request) - no payment, admin confirms later
app.post('/api/quote', (req, res) => {
  const { name, phone, email, state, product, notes } = req.body || {};
  if (!name || !phone || !product) return res.status(400).json({ error: 'Name, phone and product are required.' });
  const order = db.createOrder({
    customer: { name, phone, email: email || '', state: state || '', address: '' },
    kind: 'quote',
    itemName: product,
    qty: 1,
    unitPriceKobo: 0,
    deliveryFeeKobo: 0,
    status: 'quote',
    notes: notes || ''
  });
  res.json({ ok: true, ref: order.ref });
});

// Create an order. If it has a price, initialize Paystack payment immediately.
app.post('/api/orders', async (req, res) => {
  const { customer, item, unitPrice, deliveryFee } = req.body || {};
  if (!customer || !customer.name || !customer.phone || !item || !item.name) {
    return res.status(400).json({ error: 'Customer details and item are required.' });
  }
  if (!/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(customer.email || '')) {
    return res.status(400).json({ error: 'A valid email is required for payment.' });
  }

  const unitKobo = Math.max(0, Math.round(Number(unitPrice || 0) * 100));
  const deliveryKobo = Math.max(0, Math.round(Number(deliveryFee || 0) * 100));
  const totalKobo = unitKobo * Math.max(1, Number(item.qty || 1)) + deliveryKobo;

  let paystackRef = null, authUrl = null, status = 'quote';

  if (totalKobo > 0 && PAYMENTS_ENABLED) {
    const ref = 'APX-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const callback = `${req.protocol}://${req.get('host')}/order.html?ref=${ref}`;
    const init = await paystackInit(ref, customer.email, totalKobo, callback);
    if (!init.status) return res.status(502).json({ error: 'Paystack init failed: ' + (init.message || 'unknown error') });
    paystackRef = ref;
    authUrl = init.data.authorization_url;
    status = 'awaiting_payment';
  }

  const order = db.createOrder({
    customer,
    kind: item.kind || 'vehicle',
    itemName: item.name,
    qty: item.qty || 1,
    unitPriceKobo: unitKobo,
    deliveryFeeKobo: deliveryKobo,
    status,
    paystackRef,
    authUrl,
    notes: customer.notes || ''
  });

  res.status(201).json({ ok: true, ref: order.ref, status: order.status, authorization_url: authUrl });
});

// Order tracking - public GET
app.get('/api/order/:ref', (req, res) => {
  const order = db.getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    ref: order.ref,
    kind: order.kind,
    itemName: order.item_name,
    qty: order.qty,
    status: order.status,
    total: naira(order.total_kobo),
    createdAt: order.created_at,
    customer: { name: order.cust_name, phone: order.cust_phone, state: order.cust_state },
    canPay: PAYMENTS_ENABLED && !!(order.total_kobo > 0 && (order.status === 'awaiting_payment' || order.status === 'quote'))
  });
});

// Customer returns later to pay for a pending order - re-initialize Paystack
app.post('/api/order/:ref/pay', async (req, res) => {
  const order = db.getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!PAYMENTS_ENABLED) return res.status(400).json({ error: 'Payments are temporarily disabled. Contact us and our team will confirm your order manually.' });
  if (!order.total_kobo || order.total_kobo === 0) return res.status(400).json({ error: 'No amount set yet - awaiting quote confirmation' });
  if (['paid', 'dispatched', 'delivered', 'cancelled'].includes(order.status)) {
    return res.status(400).json({ error: 'Order cannot be paid in its current state' });
  }
  const ref = 'APX-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const callback = `${req.protocol}://${req.get('host')}/order.html?ref=${order.ref}`;
  const init = await paystackInit(ref, order.cust_email || 'customer@apexmotors.ng', order.total_kobo, callback);
  if (!init.status) return res.status(502).json({ error: 'Paystack init failed: ' + (init.message || 'unknown error') });
  db.setOrderCharge(order.id, {
    paystackRef: ref,
    authUrl: init.data.authorization_url,
    totalKobo: order.total_kobo,
    unitPriceKobo: order.unit_price_kobo,
    deliveryFeeKobo: order.delivery_fee_kobo
  });
  db.setOrderStatus(order.id, 'awaiting_payment');
  res.json({ ok: true, authorization_url: init.data.authorization_url });
});

// Re-fetch payment status from Paystack (fallback for local dev without webhook)
app.get('/api/order/:ref/verify', async (req, res) => {
  const order = db.getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.paystack_ref) return res.json({ ref: order.ref, status: order.status });
  const v = await paystackVerify(order.paystack_ref);
  if (v.status && v.data && v.data.status === 'success' && order.status !== 'paid') {
    db.setOrderStatus(order.id, 'paid');
  }
  const updated = db.getOrderByRef(req.params.ref);
  res.json({ ref: updated.ref, status: updated.status, amount: naira(v.data && v.data.amount) });
});

// Paystack webhook - server-to-server confirmation
app.post('/api/webhook/paystack', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
  const ok = sig && hash.length === sig.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(sig));
  if (!ok) return res.status(401).send('Bad signature');

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event === 'charge.success' && event.data && event.data.reference) {
    const order = db.getOrderByPaystackRef(event.data.reference);
    if (order && event.data.status === 'success') db.setOrderStatus(order.id, 'paid');
  }
  res.sendStatus(200);
});

// Customer dashboard - lookup orders by phone
app.get('/api/orders', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const orders = db.getOrdersByPhone(String(phone).trim());
  res.json(orders.map(o => ({
    ref: o.ref, kind: o.kind, itemName: o.item_name, status: o.status,
    total: naira(o.total_kobo), createdAt: o.created_at
  })));
});

// ---------- ADMIN ----------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.cookie(ADMIN_COOKIE, ADMIN_TOKEN, { httpOnly: true, sameSite: 'lax', maxAge: 86400000 });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get('/api/admin/me', isAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/orders', isAdmin, (req, res) => {
  res.json(db.getAllOrders().map(o => ({
    id: o.id, ref: o.ref, kind: o.kind, itemName: o.item_name, qty: o.qty,
    unitPrice: naira(o.unit_price_kobo), deliveryFee: naira(o.delivery_fee_kobo),
    total: naira(o.total_kobo), status: o.status, createdAt: o.created_at,
    customer: { name: o.cust_name, phone: o.cust_phone, email: o.cust_email, state: o.cust_state },
    authUrl: o.auth_url
  })));
});

app.post('/api/admin/orders/:id/status', isAdmin, (req, res) => {
  const { status } = req.body || {};
  const allowed = ['quote', 'awaiting_payment', 'paid', 'dispatched', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const order = db.getOrderById(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.setOrderStatus(order.id, status);
  res.json({ ok: true });
});

// Admin confirms final price and generates a Paystack payment link to share
app.post('/api/admin/orders/:id/charge', isAdmin, async (req, res) => {
  const { unitPrice, deliveryFee } = req.body || {};
  const order = db.getOrderById(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!PAYMENTS_ENABLED) return res.status(400).json({ error: 'Payments are temporarily disabled. Confirm the price with the customer manually (e.g. via WhatsApp) and update the order status.' });

  const unitKobo = Math.max(0, Math.round(Number(unitPrice || 0) * 100));
  const deliveryKobo = Math.max(0, Math.round(Number(deliveryFee || 0) * 100));
  const totalKobo = unitKobo * order.qty + deliveryKobo;
  if (totalKobo <= 0) return res.status(400).json({ error: 'Amount must be above zero' });

  const ref = 'APX-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const callback = `${req.protocol}://${req.get('host')}/order.html?ref=${order.ref}`;
  const init = await paystackInit(ref, order.cust_email || 'customer@apexmotors.ng', totalKobo, callback);
  if (!init.status) return res.status(502).json({ error: 'Paystack init failed: ' + (init.message || 'unknown error') });

  db.setOrderCharge(order.id, { paystackRef: ref, authUrl: init.data.authorization_url, totalKobo, unitPriceKobo: unitKobo, deliveryFeeKobo: deliveryKobo });
  res.json({ ok: true, authorization_url: init.data.authorization_url, total: naira(totalKobo) });
});

app.listen(PORT, () => {
  console.log('Apex Motors portal running at http://localhost:' + PORT);
});