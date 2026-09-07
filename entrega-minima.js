/* =============================================================
 * entrega-minima.js  —  Controle da Horta
 * -------------------------------------------------------------
 * Regra de entrega com dois mínimos, ambos editáveis por você:
 *
 *   1. POR CLIENTE  -> mínimo de ITENS no carrinho pra fechar pedido
 *   2. ACUMULADO    -> mínimo de PEDIDOS na janela pra a entrega sair
 *
 * Tudo em tempo real: onSnapshot no config e na coleção de pedidos.
 * Você muda o número no app e o catálogo do cliente atualiza sozinho,
 * sem recarregar.
 *
 * DOCUMENTO NO FIRESTORE:  config/entrega
 *   {
 *     ativo:              true,
 *     minimoItensCliente: 3,      // itens por carrinho
 *     minimoPedidos:      5,      // pedidos pra fechar a rota
 *     janelaDias:         7,      // conta pedidos dos últimos N dias
 *     recadoCatalogo:     'Entregas às terças e sextas'
 *   }
 *
 * REGRAS DO FIRESTORE (cole no console):
 *   match /config/{doc} {
 *     allow read:  if true;                  // catálogo é público
 *     allow write: if request.auth != null;  // só você edita
 *   }
 * ============================================================= */

import {
  doc, setDoc, onSnapshot,
  collection, query, where, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';


/* --- ajuste aqui se os nomes no seu Firestore forem outros --- */
const COLECAO_PEDIDOS = 'pedidos';
const CAMPO_DATA      = 'criadoEm';   // Timestamp
const CAMPO_STATUS    = 'status';
const STATUS_ABERTOS  = ['novo', 'confirmado', 'separando'];

const PADRAO = {
  ativo: true,
  minimoItensCliente: 3,
  minimoPedidos: 5,
  janelaDias: 7,
  recadoCatalogo: ''
};


const EntregaMinima = (() => {
  let db = null;
  let config = { ...PADRAO };
  let pedidosAbertos = 0;
  const ouvintes = [];

  const notificar = () => {
    const estado = calcular();
    ouvintes.forEach(fn => { try { fn(estado); } catch (e) { console.error(e); } });
  };

  /* ---------------- estado derivado ---------------- */

  function calcular() {
    const faltam = Math.max(0, config.minimoPedidos - pedidosAbertos);
    return {
      config,
      pedidosAbertos,
      faltam,
      liberado: !config.ativo || faltam === 0,
      progresso: config.minimoPedidos > 0
        ? Math.min(1, pedidosAbertos / config.minimoPedidos)
        : 1
    };
  }

  /** O carrinho do cliente pode ser fechado? */
  function validarCarrinho(itens) {
    const total = Array.isArray(itens)
      ? itens.reduce((s, i) => s + (Number(i.quantidade) || 0), 0)
      : Number(itens) || 0;

    // Pra medir em R$ em vez de itens, troque a linha acima por:
    //   const total = itens.reduce((s,i) => s + i.preco * i.quantidade, 0);
    // e renomeie minimoItensCliente -> minimoValorCliente.

    if (!config.ativo) return { ok: true, total };

    const minimo = config.minimoItensCliente;
    if (total < minimo) {
      return {
        ok: false,
        total,
        faltam: minimo - total,
        motivo: `Adicione mais ${minimo - total} ${minimo - total === 1 ? 'item' : 'itens'} para fechar o pedido (mínimo ${minimo}).`
      };
    }
    return { ok: true, total };
  }

  /* ---------------- inicialização ---------------- */

  function iniciar(firestoreDb) {
    db = firestoreDb;

    onSnapshot(doc(db, 'config', 'entrega'), snap => {
      config = snap.exists() ? { ...PADRAO, ...snap.data() } : { ...PADRAO };
      escutarPedidos();
      notificar();
    }, err => console.error('config/entrega:', err));

    return { aoMudar, validarCarrinho, calcular, salvarConfig };
  }

  let cancelarPedidos = null;

  function escutarPedidos() {
    if (cancelarPedidos) cancelarPedidos();

    const desde = new Date();
    desde.setDate(desde.getDate() - (config.janelaDias || 7));
    desde.setHours(0, 0, 0, 0);

    const q = query(
      collection(db, COLECAO_PEDIDOS),
      where(CAMPO_DATA, '>=', Timestamp.fromDate(desde)),
      where(CAMPO_STATUS, 'in', STATUS_ABERTOS)
    );

    cancelarPedidos = onSnapshot(q, snap => {
      pedidosAbertos = snap.size;
      notificar();
    }, err => console.error('pedidos:', err));
  }

  function aoMudar(fn) {
    ouvintes.push(fn);
    fn(calcular());
    return () => {
      const i = ouvintes.indexOf(fn);
      if (i > -1) ouvintes.splice(i, 1);
    };
  }

  async function salvarConfig(novo) {
    await setDoc(doc(db, 'config', 'entrega'), novo, { merge: true });
  }

  return { iniciar, aoMudar, validarCarrinho, calcular, salvarConfig };
})();


/* =============================================================
 *  FAIXA DO CATÁLOGO  (catalogo.html)
 *  Uso:  montarFaixaCatalogo(document.getElementById('faixa-entrega'))
 * ============================================================= */

export function montarFaixaCatalogo(alvo) {
  alvo.innerHTML = `
    <div class="em-faixa" role="status" aria-live="polite">
      <p class="em-titulo"></p>
      <div class="em-trilho"><div class="em-barra"></div></div>
      <p class="em-detalhe"></p>
    </div>`;

  const titulo  = alvo.querySelector('.em-titulo');
  const barra   = alvo.querySelector('.em-barra');
  const detalhe = alvo.querySelector('.em-detalhe');

  return EntregaMinima.aoMudar(({ config, pedidosAbertos, faltam, liberado, progresso }) => {
    if (!config.ativo) { alvo.hidden = true; return; }
    alvo.hidden = false;

    titulo.textContent = liberado
      ? 'Entrega confirmada para esta rodada'
      : `Faltam ${faltam} ${faltam === 1 ? 'pedido' : 'pedidos'} para sair a entrega`;

    barra.style.width = (progresso * 100).toFixed(0) + '%';
    alvo.classList.toggle('em-liberado', liberado);

    const partes = [`${pedidosAbertos} de ${config.minimoPedidos} pedidos`];
    if (config.minimoItensCliente > 1) {
      partes.push(`mínimo de ${config.minimoItensCliente} itens por pedido`);
    }
    if (config.recadoCatalogo) partes.push(config.recadoCatalogo);
    detalhe.textContent = partes.join(' · ');
  });
}


/* =============================================================
 *  PAINEL NO SEU APP  (index.html, área logada)
 *  Uso:  montarPainelAdmin(document.getElementById('painel-entrega'))
 * ============================================================= */

export function montarPainelAdmin(alvo) {
  alvo.innerHTML = `
    <section class="em-painel">
      <header class="em-painel-topo">
        <h3>Entrega mínima</h3>
        <label class="em-switch">
          <input type="checkbox" data-campo="ativo">
          <span>Regra ativa</span>
        </label>
      </header>

      <p class="em-agora"></p>
      <div class="em-trilho"><div class="em-barra"></div></div>

      <div class="em-campos">
        <label>Pedidos para sair a entrega
          <input type="number" min="1" step="1" data-campo="minimoPedidos">
        </label>
        <label>Itens mínimos por cliente
          <input type="number" min="1" step="1" data-campo="minimoItensCliente">
        </label>
        <label>Janela de contagem (dias)
          <input type="number" min="1" step="1" data-campo="janelaDias">
        </label>
        <label>Recado no catálogo
          <input type="text" maxlength="80" data-campo="recadoCatalogo"
                 placeholder="Ex: entregas às terças e sextas">
        </label>
      </div>

      <button type="button" class="em-salvar">Salvar</button>
      <p class="em-aviso" role="status" aria-live="polite"></p>
    </section>`;

  const campos  = alvo.querySelectorAll('[data-campo]');
  const agora   = alvo.querySelector('.em-agora');
  const barra   = alvo.querySelector('.em-barra');
  const botao   = alvo.querySelector('.em-salvar');
  const aviso   = alvo.querySelector('.em-aviso');
  let editando  = false;

  campos.forEach(c => c.addEventListener('focus', () => { editando = true; }));

  EntregaMinima.aoMudar(({ config, pedidosAbertos, faltam, liberado, progresso }) => {
    agora.textContent = liberado
      ? `${pedidosAbertos} pedidos — entrega liberada`
      : `${pedidosAbertos} pedidos — faltam ${faltam}`;

    barra.style.width = (progresso * 100).toFixed(0) + '%';
    alvo.classList.toggle('em-liberado', liberado);

    // não sobrescreve o que você está digitando
    if (editando) return;
    campos.forEach(c => {
      const v = config[c.dataset.campo];
      if (c.type === 'checkbox') c.checked = !!v;
      else c.value = v ?? '';
    });
  });

  botao.addEventListener('click', async () => {
    const novo = {};
    campos.forEach(c => {
      const k = c.dataset.campo;
      if (c.type === 'checkbox')    novo[k] = c.checked;
      else if (c.type === 'number') novo[k] = Math.max(1, parseInt(c.value, 10) || 1);
      else                          novo[k] = c.value.trim();
    });

    botao.disabled = true;
    try {
      await EntregaMinima.salvarConfig(novo);
      editando = false;
      aviso.textContent = 'Salvo. O catálogo já mostra o novo mínimo.';
    } catch (e) {
      console.error(e);
      aviso.textContent = 'Não salvou. Verifique a conexão e tente de novo.';
    } finally {
      botao.disabled = false;
      setTimeout(() => { aviso.textContent = ''; }, 4000);
    }
  });
}

export default EntregaMinima;
