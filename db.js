const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'apex.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  state TEXT,
  address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item_name TEXT NOT NULL,
  qty INTEGER DEFAULT 1,
  unit_price_kobo INTEGER DEFAULT 0,
  delivery_fee_kobo INTEGER DEFAULT 0,
  total_kobo INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  paystack_ref TEXT,
  auth_url TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
`);

function makeRef() {
  return 'APX-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

const upsertCustomer = db.prepare(`
  SELECT * FROM customers WHERE phone = ? ORDER BY id DESC LIMIT 1
`);

const insertCustomer = db.prepare(`
  INSERT INTO customers (name, phone, email, state, address) VALUES (?, ?, ?, ?, ?)
`);

const insertOrder = db.prepare(`
  INSERT INTO orders (ref, customer_id, kind, item_name, qty, unit_price_kobo, delivery_fee_kobo, total_kobo, status, paystack_ref, auth_url, notes)
  VALUES (@ref, @customer_id, @kind, @item_name, @qty, @unit_price_kobo, @delivery_fee_kobo, @total_kobo, @status, @paystack_ref, @auth_url, @notes)
`);

const selectOrderByRef = db.prepare(`
  SELECT o.*, c.name AS cust_name, c.phone AS cust_phone, c.email AS cust_email, c.state AS cust_state, c.address AS cust_address
  FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.ref = ?
`);

const selectOrderByPaystackRef = db.prepare(`
  SELECT * FROM orders WHERE paystack_ref = ?
`);

const selectOrderById = db.prepare(`
  SELECT o.*, c.name AS cust_name, c.phone AS cust_phone, c.email AS cust_email, c.state AS cust_state, c.address AS cust_address
  FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?
`);

const selectOrdersByPhone = db.prepare(`
  SELECT o.*, c.name AS cust_name
  FROM orders o JOIN customers c ON c.id = o.customer_id
  WHERE c.phone LIKE @phone ORDER BY o.id DESC
`);

const selectAllOrders = db.prepare(`
  SELECT o.*, c.name AS cust_name, c.phone AS cust_phone, c.email AS cust_email, c.state AS cust_state
  FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC
`);

const updateOrderStatus = db.prepare(`UPDATE orders SET status = ? WHERE id = ?`);

const updateOrderCharge = db.prepare(`
  UPDATE orders SET paystack_ref = ?, auth_url = ?, total_kobo = ?, unit_price_kobo = ?, delivery_fee_kobo = ?, status = 'awaiting_payment' WHERE id = ?
`);

function createCustomer(name, phone, email, state, address) {
  let existing = upsertCustomer.get(phone);
  if (!existing) {
    const info = insertCustomer.run(name, phone, email || null, state || null, address || null);
    existing = { id: info.lastInsertRowid, name, phone, email, state, address };
  }
  return existing;
}

function createOrder({ customer, kind, itemName, qty, unitPriceKobo, deliveryFeeKobo, status, paystackRef, authUrl, notes }) {
  const cust = createCustomer(customer.name, customer.phone, customer.email, customer.state, customer.address);
  const ref = makeRef();
  const total = Number(unitPriceKobo || 0) + Number(deliveryFeeKobo || 0);
  const info = insertOrder.run({
    ref,
    customer_id: cust.id,
    kind,
    item_name: itemName,
    qty: Number(qty || 1),
    unit_price_kobo: Number(unitPriceKobo || 0),
    delivery_fee_kobo: Number(deliveryFeeKobo || 0),
    total_kobo: total,
    status: status || 'awaiting_payment',
    paystack_ref: paystackRef || null,
    auth_url: authUrl || null,
    notes: notes || null
  });
  return getOrderById(info.lastInsertRowid);
}

function getOrderByRef(ref) { return selectOrderByRef.get(ref); }
function getOrderByPaystackRef(ref) { return selectOrderByPaystackRef.get(ref); }
function getOrderById(id) { return selectOrderById.get(id); }
function getOrdersByPhone(phone) { return selectOrdersByPhone.all({ phone: '%' + phone.replace(/[\s-]/g, '') + '%' }); }
function getAllOrders() { return selectAllOrders.all(); }
function setOrderStatus(id, status) { updateOrderStatus.run(status, id); }
function setOrderCharge(id, { paystackRef, authUrl, totalKobo, unitPriceKobo, deliveryFeeKobo }) {
  updateOrderCharge.run(paystackRef, authUrl, totalKobo, unitPriceKobo, deliveryFeeKobo, id);
}

module.exports = {
  createOrder,
  getOrderByRef,
  getOrderByPaystackRef,
  getOrderById,
  getOrdersByPhone,
  getAllOrders,
  setOrderStatus,
  setOrderCharge
};