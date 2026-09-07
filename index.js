const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

admin.initializeApp();
const db = admin.firestore();

// Guardado com segurança fora do código (ver instruções de deploy).
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');

// Ajuste se o link do catálogo for diferente.
const CATALOGO_URL = 'https://fernandofckc-del.github.io/horta-app/catalogo.html';

// Região/projeto usados para montar a URL do webhook automaticamente.
const REGIAO = 'us-central1';
const PROJETO_ID = 'horta-app-6a4ca';

function mpClient() {
  return new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN.value() });
}

function aplicarCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

// ============================================================
// 1) Cria a preferência de pagamento (PIX + Cartão) no Mercado Pago
//    e devolve o link de checkout (init_point) para o catalogo.html.
//    NUNCA confia no preço/estoque que vem do navegador — revalida tudo
//    contra os dados reais salvos na nuvem antes de gerar a cobrança.
// ============================================================
exports.criarPagamento = onRequest({ secrets: [MP_ACCESS_TOKEN] }, async (req, res) => {
  aplicarCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  try {
    const { uid, itens } = req.body || {};
    if (!uid || !Array.isArray(itens) || itens.length === 0) {
      res.status(400).json({ erro: 'Dados inválidos.' });
      return;
    }

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      res.status(404).json({ erro: 'Vendedor não encontrado.' });
      return;
    }
    const produtos = (userDoc.data().dump && userDoc.data().dump.hg_produtos) || [];

    const itensValidados = [];
    for (const item of itens) {
      const produto = produtos.find((p) => p.id === item.produtoId);
      if (!produto) continue;
      const qtd = Math.max(0, Math.min(Number(item.quantidade) || 0, produto.estoqueAtual || 0));
      if (qtd <= 0) continue;
      const precoUsar = (produto.precoPromocional && produto.precoPromocional > 0 && produto.precoPromocional < produto.preco) ? produto.precoPromocional : produto.preco;
      itensValidados.push({ id: produto.id, title: produto.nome, quantity: qtd, unit_price: Number(precoUsar) });
    }
    if (itensValidados.length === 0) {
      res.status(400).json({ erro: 'Itens indisponíveis ou sem estoque suficiente.' });
      return;
    }

    const pedidoRef = await db.collection('pedidos').add({
      uid,
      itens: itensValidados,
      status: 'pendente',
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    const preference = new Preference(mpClient());
    const resultado = await preference.create({
      body: {
        items: itensValidados.map((i) => ({
          title: i.title,
          quantity: i.quantity,
          unit_price: i.unit_price,
          currency_id: 'BRL'
        })),
        external_reference: pedidoRef.id,
        notification_url: `https://${REGIAO}-${PROJETO_ID}.cloudfunctions.net/webhookMercadoPago`,
        back_urls: {
          success: `${CATALOGO_URL}?u=${uid}&status=sucesso`,
          pending: `${CATALOGO_URL}?u=${uid}&status=pendente`,
          failure: `${CATALOGO_URL}?u=${uid}&status=falha`
        },
        auto_return: 'approved'
      }
    });

    await pedidoRef.update({ mpPreferenceId: resultado.id });
    res.json({ init_point: resultado.init_point });
  } catch (err) {
    console.error('Erro em criarPagamento:', err);
    res.status(500).json({ erro: 'Erro ao criar pagamento.' });
  }
});

// ============================================================
// 2) Webhook do Mercado Pago — chamado automaticamente quando o
//    pagamento é aprovado. Só AQUI o estoque é descontado de verdade
//    e a venda é registrada, nunca a partir do navegador do cliente.
// ============================================================
exports.webhookMercadoPago = onRequest({ secrets: [MP_ACCESS_TOKEN] }, async (req, res) => {
  try {
    const tipo = req.query.type || (req.body && req.body.type);
    const id = req.query['data.id'] || req.query.id || (req.body && req.body.data && req.body.data.id);
    if (tipo !== 'payment' || !id) {
      res.status(200).send('ignorado');
      return;
    }

    const payment = new Payment(mpClient());
    const pagamento = await payment.get({ id });

    if (pagamento.status !== 'approved') {
      res.status(200).send('aguardando confirmação');
      return;
    }

    const pedidoId = pagamento.external_reference;
    if (!pedidoId) { res.status(200).send('sem referência de pedido'); return; }

    const pedidoRef = db.collection('pedidos').doc(pedidoId);

    await db.runTransaction(async (tx) => {
      const pedidoSnap = await tx.get(pedidoRef);
      if (!pedidoSnap.exists) return;
      const pedido = pedidoSnap.data();
      if (pedido.status === 'aprovado') return; // já processado antes (evita descontar 2x)

      const userRef = db.collection('users').doc(pedido.uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;
      const dump = userSnap.data().dump || {};
      const produtos = [...(dump.hg_produtos || [])];
      const vendas = [...(dump.hg_vendas || [])];

      const itensVenda = [];
      for (const item of pedido.itens) {
        const idx = produtos.findIndex((p) => p.id === item.id);
        if (idx === -1) continue;
        produtos[idx] = { ...produtos[idx], estoqueAtual: Math.max(0, (produtos[idx].estoqueAtual || 0) - item.quantity) };
        itensVenda.push({ produtoId: item.id, nome: item.title, precoUnitario: item.unit_price, quantidade: item.quantity });
      }

      const total = pedido.itens.reduce((s, i) => s + i.unit_price * i.quantity, 0);
      vendas.push({
        id: pedidoId,
        data: new Date().toISOString(),
        clienteId: null,
        itens: itensVenda,
        total,
        formaPagamento: pagamento.payment_type_id === 'credit_card' ? 'Cartão (online)' : 'PIX (online)'
      });

      tx.update(userRef, { 'dump.hg_produtos': produtos, 'dump.hg_vendas': vendas });
      tx.update(pedidoRef, {
        status: 'aprovado',
        aprovadoEm: admin.firestore.FieldValue.serverTimestamp(),
        mpPaymentId: String(id)
      });
    });

    res.status(200).send('ok');
  } catch (err) {
    console.error('Erro em webhookMercadoPago:', err);
    res.status(500).send('erro');
  }
});
