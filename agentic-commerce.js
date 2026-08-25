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

console.log(`✅ Payment processing active – Checkout UI: ${CHECKOUT_UI}`)
console.log(`   BASE_URL: ${BASE_URL}`)

// ---------- Catalog (replace with your real products) ----------
const items = [
  { id: 'coffee', title: 'Premium Coffee', priceCents: 500 },
  { id: 'donation', title: 'Donation', priceCents: 1000 },
  { id: 'subscription', title: 'Monthly Subscription', priceCents: 2000 },
]
function getItem(id) { return items.find(i => i.id === id) }
function completeOrder({ item, quantity, amount }) {
  return { id: `${item.id}-${quantity}-${Date.now()}`, status: 'completed', amount }
}

// ---------- MPP Setup (for agent payments) ----------
const stripeClient = new Stripe(STRIPE_SECRET_KEY)
const mppSecretKey = crypto
  .createHmac('sha256', STRIPE_SECRET_KEY)
  .update('mpp-challenge-signing')
  .digest('base64')
const stripeMachinePayments = stripe.create({
  client: stripeClient,
  networkId: STRIPE_NETWORK_ID,
  livemode: true,
})
const mppx = Mppx.create({
  methods: [stripeMachinePayments.spt.charge()],
  secretKey: mppSecretKey,
})

// ---------- HTTP Server ----------
const app = new Hono()

// Health check
app.get('/', (c) => c.text('Hello World!'))

// API key authentication for all payment endpoints
app.use('*', async (c, next) => {
  const apiKey = c.req.header('X-API-Key')
  if (apiKey !== API_SECRET_KEY) {
    return c.json({ error: 'Unauthorized – missing or invalid X-API-Key header' }, 401)
  }
  await next()
})

// --- MPP endpoint for direct fund withdrawal ---
app.on(['GET', 'POST'], '/api/purchase', async (c) => {
  const request = c.req.raw
  const url = new URL(request.url)
  const params = url.searchParams

  const itemId = params.get('itemId')
  const item = getItem(itemId)
  if (!item) return c.json({ error: 'Item not found' }, 404)

  const quantity = Number(params.get('quantity')) || 1

  // Browser fallback – redirect to Checkout
  const accept = request.headers.get('Accept') || ''
  if (accept.includes('text/html')) {
    const checkoutUrl = new URL('/checkout', BASE_URL)
    checkoutUrl.search = params.toString()
    return c.redirect(checkoutUrl.toString())
  }

  // Agent path – direct withdrawal via MPP
  const amount = ((item.priceCents * quantity) / 100).toFixed(2)

  const result = await mppx.compose([
    'stripe/charge',
    {
      amount,
      currency: 'usd',
      decimals: 2,
      description: `${item.title} (x${quantity})`,
    },
  ])(request)

  if (result.status === 402) {
    return new Response(result.challenge.body, {
      status: 402,
      headers: result.challenge.headers,
    })
  }

  const order = completeOrder({ item, quantity, amount })
  return result.withReceipt(
    c.json({ success: true, orderId: order.id, item: item.title, amount, quantity })
  )
})

// --- Direct withdrawal endpoint ---
app.post('/api/withdraw', async (c) => {
  const body = await c.req.json()
  const schema = z.object({
    amount: z.number().positive(),
    currency: z.string().default('usd'),
    description: z.string().optional().default('Withdrawal'),
  })
  const parse = schema.safeParse(body)
  if (!parse.success) return c.json({ error: parse.error.message }, 400)

  const { amount, currency, description } = parse.data

  const result = await mppx.compose([
    'stripe/charge',
    {
      amount: amount.toFixed(2),
      currency,
      decimals: 2,
      description,
    },
  ])(c.req.raw)

  if (result.status === 402) {
    return new Response(result.challenge.body, {
      status: 402,
      headers: result.challenge.headers,
    })
  }

  return result.withReceipt(
    c.json({ success: true, amount, currency, description })
  )
})

// --- Checkout endpoint for humans (Stripe-hosted) ---
app.post('/checkout', async (c) => {
  const body = await c.req.json()
  const schema = z.object({
    cart: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })),
    buyer: z.object({ email: z.string().email().optional() }).optional(),
    currency: z.string().default('usd'),
    returnUrl: z.string().url().optional(),
    ui: z.enum(['hosted', 'embedded', 'elements']).optional().default(CHECKOUT_UI),
  })
  const parse = schema.safeParse(body)
  if (!parse.success) return c.json({ error: parse.error.message }, 400)

  const { cart, buyer, currency, returnUrl, ui } = parse.data

  const lineItems = await Promise.all(cart.map(async (item) => {
    const product = getItem(item.sku)
    if (!product) throw new Error(`Product ${item.sku} not found`)
    return {
      price_data: {
        currency,
        product_data: { name: product.title },
        unit_amount: product.priceCents,
      },
      quantity: item.quantity,
    }
  }))

  const sessionParams = {
    line_items: lineItems,
    mode: 'payment',
    customer_email: buyer?.email,
    metadata: { source: 'checkout' },
  }

  if (ui === 'hosted') {
    sessionParams.success_url = returnUrl || `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`
    sessionParams.cancel_url = `${BASE_URL}/cancel`
  } else {
    sessionParams.ui_mode = ui === 'embedded' ? 'embedded' : 'elements'
    sessionParams.return_url = returnUrl || `${BASE_URL}/return?session_id={CHECKOUT_SESSION_ID}`
  }

  const session = await stripeClient.checkout.sessions.create(sessionParams)

  if (ui === 'hosted') {
    return c.json({ checkoutId: session.id, paymentUrl: session.url })
  } else {
    return c.json({ checkoutId: session.id, clientSecret: session.client_secret })
  }
})

// --- Webhook (optional, for fulfilment) ---
app.post('/webhook', async (c) => {
  // Uncomment and add your webhook secret to verify events
  // const sig = c.req.header('stripe-signature')
  // const payload = await c.req.text()
  // const event = stripeClient.webhooks.constructEvent(payload, sig, process.env.WEBHOOK_SECRET)
  // if (event.type === 'checkout.session.completed') { ... }
  return c.text('OK')
})

// ---------- Start the server ----------
serve({ fetch: app.fetch, port: Number(PORT) })
console.log(`🚀 HTTP server on ${BASE_URL}`)
console.log(`   MPP (agents): ${BASE_URL}/api/purchase`)
console.log(`   Direct withdrawal: ${BASE_URL}/api/withdraw`)
console.log(`   Checkout (humans): ${BASE_URL}/checkout (UI: ${CHECKOUT_UI})`)
console.log(`   Webhook: ${BASE_URL}/webhook`)
