# Agentic Commerce – Complete Architecture & Code Reference

## Overview

This is a **production-grade Stripe payment server** supporting both **agent-based payments** (via Machine Payment Protocol) and **human checkout** flows.

### Key Responsibilities

| Component | Purpose |
|-----------|---------|
| **MPP Endpoint** (`/api/purchase`) | Agents pay via 402 HTTP payment challenge protocol with cryptographic signing |
| **Checkout Endpoint** (`/checkout`) | Humans get Stripe-hosted, embedded, or element-based checkout UI |
| **Webhook** (`/webhook`) | Listens for Stripe events (fulfillment logic ready) |
| **Catalog & Fulfillment** | Simple product list + order completion logic |

---

## Architecture

### **Imports & Framework**
- **Hono**: Lightweight HTTP server (Node.js)
- **Stripe SDK**: Direct charge API + checkout sessions
- **MPPX**: Machine Payment Protocol library (agents → 402 challenges)
- **Zod**: Schema validation for checkout requests

### **Security**
1. **API Key Middleware** (`X-API-Key` header) — required on `/api/*` routes
2. **Live Mode Enforcement** — rejects test keys; asserts `sk_live_*` format
3. **HMAC-SHA256 signing** — derives MPP secret key from Stripe secret
4. **Environment Validation** — exits if `STRIPE_SECRET_KEY`, `STRIPE_NETWORK_ID`, `API_SECRET_KEY`, `BASE_URL` missing

### **Payment Flows**

#### Agent Flow (MPP / 402)
```
Agent sends GET/POST /api/purchase?itemId=X&quantity=N
  → Validates item + quantity
  → Composes MPP challenge (stripe/charge)
  → Returns 402 + challenge body/headers
  → Agent signs challenge, returns payment proof
  → Server verifies & completes order
```

#### Human Flow (Checkout)
```
POST /checkout { cart: [...], buyer, ui: 'hosted'|'embedded'|'elements' }
  → Builds line items from catalog
  → Creates Stripe session (mode: 'payment')
  → Returns checkout ID + URL/client secret (based on UI mode)
  → User completes payment on Stripe-hosted page or embedded widget
```

---

## Key Functions & Exports

| Symbol | Purpose |
|--------|---------|
| `items` | Hardcoded product catalog (coffee, donation, subscription) |
| `getItem(id)` | Lookup product by ID |
| `validatePurchase({item, quantity})` | Pre-purchase validation |
| `completeOrder({item, quantity})` | Fulfillment stub (generates order ID) |
| `stripeClient` | Stripe API client |
| `mppx` | MPP challenge composer & receiver |
| `app` | Hono HTTP server instance |

---

## Critical Config & Constraints

| Setting | Requirement | Notes |
|---------|-------------|-------|
| `STRIPE_SECRET_KEY` | `sk_live_*` | Rejects `sk_test_*`; exits if malformed |
| `STRIPE_NETWORK_ID` | `profile_*` | MPP network profile ID |
| `API_SECRET_KEY` | Any string | Protects payment endpoints via header |
| `BASE_URL` | Full URL | Used in Stripe success/cancel redirects |
| `CHECKOUT_UI` | `'hosted'` \| `'embedded'` \| `'elements'` | Default: `'hosted'`; controls Stripe session type |
| `PORT` | Number | Default: `3000` |

---

## Notable Design Choices

1. **Strict Live Mode** — `_test_` key detection + format validation prevent accidental test charges
2. **Dual UX** — HTTP `Accept` header routes browsers → checkout; APIs → MPP/402
3. **Flexible Checkout UI** — `ui` parameter lets clients pick hosted, embedded, or custom elements integration
4. **Simple Catalog** — Product data is inline; production would load from DB
5. **Webhook Stub** — Signature verification commented out; ready for fulfillment logic (sends email, ships, etc.)

---

## Full Source Code

```javascript
// ================================================================
// FILE: agentic-commerce.js – Strictly Money‑Making HTTP Server
// ================================================================
// Env vars: STRIPE_SECRET_KEY, STRIPE_NETWORK_ID, API_SECRET_KEY, BASE_URL
// Run:       node agentic-commerce.js
// ================================================================

import crypto from 'crypto'
import Stripe from 'stripe'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Mppx, stripe } from 'mppx/server'
import { z } from 'zod'

// ---------- Environment ----------
const {
  STRIPE_SECRET_KEY,
  STRIPE_NETWORK_ID,
  API_SECRET_KEY,
  BASE_URL,
  CHECKOUT_UI = 'hosted',
  PORT = process.env.PORT || 3000,
} = process.env

if (!STRIPE_SECRET_KEY || !STRIPE_NETWORK_ID || !API_SECRET_KEY || !BASE_URL) {
  console.error('❌ Missing required env: STRIPE_SECRET_KEY, STRIPE_NETWORK_ID, API_SECRET_KEY, BASE_URL')
  process.exit(1)
}

// --- LIVE MODE CHECKS ---
if (STRIPE_SECRET_KEY.includes('_test_')) {
  console.error('❌ Test key detected. Use a LIVE secret key (sk_live_...).')
  process.exit(1)
}
if (!STRIPE_SECRET_KEY.startsWith('sk_live_')) {
  console.error('❌ Invalid secret key format. Must start with sk_live_.')
  process.exit(1)
}
if (!STRIPE_NETWORK_ID.startsWith('profile_')) {
  console.error('❌ Invalid network ID format. Must start with profile_.')
  process.exit(1)
}
console.log(`✅ LIVE MODE – Checkout UI: ${CHECKOUT_UI}`)
console.log(`   BASE_URL: ${BASE_URL}`)

// ---------- Catalog (replace with your real products) ----------
const items = [
  { id: 'coffee', title: 'Premium Coffee', priceCents: 500 },
  { id: 'donation', title: 'Donation', priceCents: 1000 },
  { id: 'subscription', title: 'Monthly Subscription', priceCents: 2000 },
]

/**
 * Retrieve an item from the catalog by ID
 * @param {string} id - The item ID
 * @returns {Object|undefined} The item object or undefined if not found
 */
function getItem(id) {
  return items.find(i => i.id === id)
}

/**
 * Validate a purchase before processing
 * @param {Object} params - Purchase parameters
 * @param {Object} params.item - The item being purchased
 * @param {number} params.quantity - The quantity to purchase
 * @throws {Error} If quantity is invalid
 */
function validatePurchase({ item, quantity }) {
  if (quantity < 1) throw new Error('Quantity must be positive')
}

/**
 * Complete an order and return fulfillment details
 * Replace with your actual fulfillment logic (send email, update inventory, etc.)
 * @param {Object} params - Order parameters
 * @param {Object} params.item - The item purchased
 * @param {number} params.quantity - The quantity purchased
 * @returns {Object} Order details { id, status }
 */
function completeOrder({ item, quantity }) {
  return {
    id: `${item.id}-${quantity}-${Date.now()}`,
    status: 'completed'
  }
}

// ---------- MPP Setup (for agent payments) ----------
const stripeClient = new Stripe(STRIPE_SECRET_KEY)

/**
 * Derive MPP secret key from Stripe secret using HMAC-SHA256
 * Used to sign and verify Machine Payment Protocol challenges
 */
const mppSecretKey = crypto
  .createHmac('sha256', STRIPE_SECRET_KEY)
  .update('mpp-challenge-signing')
  .digest('base64')

/**
 * Initialize Stripe Machine Payments for MPP (402 challenge) flow
 */
const stripeMachinePayments = stripe.create({
  client: stripeClient,
  networkId: STRIPE_NETWORK_ID,
  livemode: true,
})

/**
 * MPPX instance that composes and verifies 402 payment challenges
 */
const mppx = Mppx.create({
  methods: [stripeMachinePayments.spt.charge()],
  secretKey: mppSecretKey,
})

// ---------- HTTP Server ----------
const app = new Hono()

/**
 * Health check endpoint
 * GET /
 * Returns: Plain text "Hello World!"
 */
app.get('/', (c) => c.text('Hello World!'))

/**
 * API key authentication middleware
 * Applies to all routes (authenticated via X-API-Key header)
 * Returns 401 if key is missing or invalid
 */
app.use('*', async (c, next) => {
  const apiKey = c.req.header('X-API-Key')
  if (apiKey !== API_SECRET_KEY) {
    return c.json(
      { error: 'Unauthorized – missing or invalid X-API-Key header' },
      401
    )
  }
  await next()
})

// --- MPP endpoint for agents (402 challenge) ---
/**
 * Purchase endpoint supporting both agent (MPP/402) and browser (redirect) flows
 * GET/POST /api/purchase?itemId=ITEM&quantity=N
 *
 * Agent flow:
 *   - Sends request without Accept: text/html header
 *   - Receives 402 with MPP challenge
 *   - Signs challenge and returns payment proof
 *
 * Browser flow:
 *   - Sends request with Accept: text/html header
 *   - Gets redirected to /checkout
 */
app.on(['GET', 'POST'], '/api/purchase', async (c) => {
  const request = c.req.raw
  const url = new URL(request.url)
  const params = url.searchParams

  // Extract and validate item
  const itemId = params.get('itemId')
  const item = getItem(itemId)
  if (!item) return c.json({ error: 'Item not found' }, 404)

  // Extract and validate quantity
  const quantity = Number(params.get('quantity')) || 1
  if (quantity < 1) return c.json({ error: 'Invalid quantity' }, 400)

  // Browser fallback – redirect to Checkout
  const accept = request.headers.get('Accept') || ''
  if (accept.includes('text/html')) {
    const checkoutUrl = new URL('/checkout', BASE_URL)
    checkoutUrl.search = params.toString()
    return c.redirect(checkoutUrl.toString())
  }

  // Agent path – MPP flow
  try {
    validatePurchase({ item, quantity })
  } catch (err) {
    return c.json({ error: err.message }, 400)
  }

  // Compose MPP 402 challenge
  const result = await mppx.compose([
    'stripe/charge',
    {
      amount: ((item.priceCents * quantity) / 100).toFixed(2),
      currency: 'usd',
      decimals: 2,
      description: item.title,
    },
  ])(request)

  // Return 402 challenge if payment proof not included
  if (result.status === 402) {
    return new Response(result.challenge.body, {
      status: 402,
      headers: result.challenge.headers,
    })
  }

  // Payment proof received – complete order
  const order = completeOrder({ item, quantity })
  return result.withReceipt(
    c.json({ success: true, orderId: order.id, item: item.title })
  )
})

// --- Checkout endpoint for humans (Stripe-hosted) ---
/**
 * Create a Stripe checkout session for human users
 * POST /checkout
 *
 * Request body:
 *   {
 *     cart: [{ sku: "coffee", quantity: 2 }, ...],
 *     buyer: { email: "user@example.com" },
 *     currency: "usd",
 *     returnUrl: "https://example.com/success",
 *     ui: "hosted" | "embedded" | "elements"
 *   }
 *
 * Response:
 *   - "hosted": { checkoutId, paymentUrl } → redirect user to paymentUrl
 *   - "embedded"/"elements": { checkoutId, clientSecret } → embed in frontend
 */
app.post('/checkout', async (c) => {
  const body = await c.req.json()

  // Validate request schema
  const schema = z.object({
    cart: z.array(
      z.object({
        sku: z.string(),
        quantity: z.number().int().positive(),
      })
    ),
    buyer: z
      .object({
        email: z.string().email().optional(),
      })
      .optional(),
    currency: z.string().default('usd'),
    returnUrl: z.string().url().optional(),
    ui: z
      .enum(['hosted', 'embedded', 'elements'])
      .optional()
      .default(CHECKOUT_UI),
  })

  const parse = schema.safeParse(body)
  if (!parse.success) {
    return c.json({ error: parse.error.message }, 400)
  }

  const { cart, buyer, currency, returnUrl, ui } = parse.data

  // Build line items from cart
  const lineItems = await Promise.all(
    cart.map(async (cartItem) => {
      const product = getItem(cartItem.sku)
      if (!product) throw new Error(`Product ${cartItem.sku} not found`)
      return {
        price_data: {
          currency,
          product_data: { name: product.title },
          unit_amount: product.priceCents,
        },
        quantity: cartItem.quantity,
      }
    })
  )

  // Build Stripe session parameters
  const sessionParams = {
    line_items: lineItems,
    mode: 'payment',
    customer_email: buyer?.email,
    metadata: { source: 'checkout' },
  }

  // Configure based on UI mode
  if (ui === 'hosted') {
    sessionParams.success_url =
      returnUrl || `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`
    sessionParams.cancel_url = `${BASE_URL}/cancel`
  } else {
    sessionParams.ui_mode = ui === 'embedded' ? 'embedded' : 'elements'
    sessionParams.return_url =
      returnUrl || `${BASE_URL}/return?session_id={CHECKOUT_SESSION_ID}`
  }

  // Create Stripe session
  const session = await stripeClient.checkout.sessions.create(sessionParams)

  // Return appropriate response based on UI mode
  if (ui === 'hosted') {
    return c.json({
      checkoutId: session.id,
      paymentUrl: session.url,
    })
  } else {
    return c.json({
      checkoutId: session.id,
      clientSecret: session.client_secret,
    })
  }
})

// --- Webhook (optional, for fulfilment) ---
/**
 * Stripe webhook endpoint for order fulfillment
 * POST /webhook
 *
 * To enable:
 * 1. Uncomment the event construction and signature verification
 * 2. Set process.env.WEBHOOK_SECRET to your Stripe webhook signing secret
 * 3. Configure the webhook in Stripe Dashboard → Developers → Webhooks
 * 4. Implement fulfillment logic for: checkout.session.completed, payment_intent.succeeded, etc.
 */
app.post('/webhook', async (c) => {
  // Uncomment and add your webhook secret to verify events:
  // const sig = c.req.header('stripe-signature')
  // const payload = await c.req.text()
  // const event = stripeClient.webhooks.constructEvent(
  //   payload,
  //   sig,
  //   process.env.WEBHOOK_SECRET
  // )
  //
  // if (event.type === 'checkout.session.completed') {
  //   const session = event.data.object
  //   // TODO: Fulfill the order
  //   // - Send confirmation email
  //   // - Update database
  //   // - Trigger fulfillment workflow
  //   // - Grant access to digital product
  // }
  //
  // if (event.type === 'payment_intent.succeeded') {
  //   // Handle recurring payments, subscriptions, etc.
  // }

  return c.text('OK')
})

// ---------- Start the server ----------
serve({ fetch: app.fetch, port: Number(PORT) })
console.log(`🚀 LIVE HTTP server on ${BASE_URL}`)
console.log(`   MPP (agents): ${BASE_URL}/api/purchase`)
console.log(
  `   Checkout (humans): ${BASE_URL}/checkout (UI: ${CHECKOUT_UI})`
)
console.log(`   Webhook: ${BASE_URL}/webhook`)
```

---

## Environment Setup

Create a `.env` file (do NOT commit to version control):

```bash
# Stripe credentials (LIVE mode only)
STRIPE_SECRET_KEY=sk_live_your_secret_key_here
STRIPE_NETWORK_ID=profile_your_network_id_here

# Server security
API_SECRET_KEY=your_random_api_key_here
BASE_URL=https://yourserver.com

# Optional
CHECKOUT_UI=hosted
PORT=3000
WEBHOOK_SECRET=whsec_your_webhook_secret_here
```

---

## Installation & Run

```bash
# Install dependencies
npm install stripe @hono/node-server hono mppx zod crypto

# Set environment variables
export STRIPE_SECRET_KEY=sk_live_...
export STRIPE_NETWORK_ID=profile_...
export API_SECRET_KEY=your_key
export BASE_URL=https://yourserver.com

# Run the server
node agentic-commerce.js

# Output:
# ✅ LIVE MODE – Checkout UI: hosted
#    BASE_URL: https://yourserver.com
# 🚀 LIVE HTTP server on https://yourserver.com
#    MPP (agents): https://yourserver.com/api/purchase
#    Checkout (humans): https://yourserver.com/checkout (UI: hosted)
#    Webhook: https://yourserver.com/webhook
```

---

## API Usage Examples

### Agent Payment (MPP / 402 Challenge)

```bash
# Step 1: Request a payment challenge
curl -X GET "https://yourserver.com/api/purchase?itemId=coffee&quantity=1" \
  -H "X-API-Key: your_api_key"

# Response (402 Payment Required):
# HTTP/1.1 402 Payment Required
# {
#   "challenge": {
#     "body": "...",
#     "headers": { ... }
#   }
# }

# Step 2: Sign the challenge (agent-side) and POST proof
curl -X POST "https://yourserver.com/api/purchase?itemId=coffee&quantity=1" \
  -H "X-API-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{ "signature": "...", "proof": "..." }'

# Response (200 OK):
# {
#   "success": true,
#   "orderId": "coffee-1-1692345678901",
#   "item": "Premium Coffee"
# }
```

### Human Checkout (Stripe-Hosted)

```bash
# Request a checkout session
curl -X POST "https://yourserver.com/checkout" \
  -H "X-API-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "cart": [
      { "sku": "coffee", "quantity": 2 },
      { "sku": "donation", "quantity": 1 }
    ],
    "buyer": { "email": "user@example.com" },
    "ui": "hosted"
  }'

# Response (200 OK):
# {
#   "checkoutId": "cs_test_...",
#   "paymentUrl": "https://checkout.stripe.com/pay/cs_test_..."
# }

# User clicks paymentUrl → completes payment on Stripe → redirected to success_url
```

### Embedded Checkout

```bash
curl -X POST "https://yourserver.com/checkout" \
  -H "X-API-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "cart": [{ "sku": "coffee", "quantity": 1 }],
    "ui": "embedded"
  }'

# Response:
# {
#   "checkoutId": "cs_test_...",
#   "clientSecret": "cs_test_..._secret_..."
# }

# Frontend: Embed Stripe Checkout using clientSecret
# <stripe-checkout client-secret="cs_test_..._secret_..."></stripe-checkout>
```

---

## Production Checklist

- [ ] Use `sk_live_*` keys (never test keys)
- [ ] Set `API_SECRET_KEY` to a strong random value
- [ ] Store all env vars in a secure vault (AWS Secrets Manager, HashiCorp Vault, etc.)
- [ ] Enable webhook signature verification (uncomment webhook code)
- [ ] Implement order fulfillment logic (email, inventory, etc.)
- [ ] Use HTTPS for all endpoints
- [ ] Set up rate limiting and DDoS protection
- [ ] Log payment events for auditing
- [ ] Test with Stripe staging environment before going live
- [ ] Monitor error rates and failed transactions
- [ ] Set up alerts for unusual payment patterns

---

## Questions or Changes?

- **Modify catalog** → Update the `items` array
- **Add fulfillment** → Implement webhook event handler (uncomment signature verification)
- **Adjust MPP signing** → Change the HMAC derivation in `mppSecretKey`
- **Scale checkout** → Move product data to a database query in the `/checkout` handler
- **Add authentication** → Layer OAuth2 or JWT on top of the existing `X-API-Key` middleware
