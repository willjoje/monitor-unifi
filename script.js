import axios from 'axios';
import cron from 'node-cron';
import nodemailer from 'nodemailer';

// ==========================================
// 1. CONFIGURAÇÕES
// ==========================================

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: 'tiqualiport@gmail.com',
    pass: 'dhxp ftrm sljc resq' 
  }
});
const EMAIL_ALERTA_DESTINO = 'ti@qualiport.com.br';

const UNIFI_API_URL = 'https://api.ui.com/v1/hosts';
const UNIFI_API_KEY = '4aIypKqJoWGE9YJnSywr7gHTsuuWCcOi';

const AUVO_API_KEY = '6Dg9SRzN3EivhKG1rZwjRYKQlfbntajh';
const AUVO_API_TOKEN = '6Dg9SRzN3Ejr8tmzIYkpTZB352cUqVK';

// ---------------------------------------------------------
// PARÂMETROS AJUSTADOS (IDs do Auvo)
// ---------------------------------------------------------
const ID_CLIENTE_PADRAO = 14248700; 
const ID_TIPO_CHAMADO = 0;          // ⬅️ COLOQUE AQUI O ID DO TIPO
const ID_STATUS_OFFLINE = 108504;    // ⬅️ COLOQUE AQUI O ID DO STATUS "Unify Offline" (Ex: antigo 95495)
const ID_STATUS_ONLINE = 108505;     // ⬅️ COLOQUE AQUI O ID DO STATUS "Unify Online"

let auvoAccessToken = null;
let auvoTokenExpiration = 0;

// Caches de estado
const offlineGatewaysCache = new Map();   // Guarda { ticketId, openedAt }
const pendingValidationCache = new Set(); // Guarda IDs pendentes para a validação de 5 min

// ==========================================
// 2. FUNÇÕES ÚTEIS
// ==========================================

function getHorario() {
  return new Date().toLocaleTimeString('pt-BR');
}

// Converte os milissegundos de inatividade para um formato legível (Ex: 1h 5m 30s)
function formatarTempoOffline(ms) {
  const segundos = Math.floor((ms / 1000) % 60);
  const minutos = Math.floor((ms / (1000 * 60)) % 60);
  const horas = Math.floor((ms / (1000 * 60 * 60)) % 24);

  const partes = [];
  if (horas > 0) partes.push(`${horas}h`);
  if (minutos > 0) partes.push(`${minutos}m`);
  if (segundos > 0 || partes.length === 0) partes.push(`${segundos}s`);

  return partes.join(' ');
}

// ==========================================
// 3. INTEGRAÇÕES DE API
// ==========================================

async function getAuvoToken() {
  const agora = Date.now();
  if (auvoAccessToken && agora < auvoTokenExpiration - (2 * 60 * 1000)) return auvoAccessToken;
  
  try {
    const response = await axios.post('https://api.auvo.com.br/v2/login', {
      apiKey: AUVO_API_KEY,
      apiToken: AUVO_API_TOKEN
    });
    auvoAccessToken = response.data.result.accessToken;
    auvoTokenExpiration = agora + (30 * 60 * 1000); 
    return auvoAccessToken;
  } catch (error) {
    throw new Error(error.message);
  }
}

async function openAuvoTicket(gateway) {
  const nomeGateway = gateway.reportedState?.name || 'Desconhecido';
  
  try {
    const token = await getAuvoToken();
    
    const ticketData = {
      title: `Condomínio ${nomeGateway} Offline`,
      description: `O Gateway "${nomeGateway}" perdeu a comunicação com o Site Manager.`,
      priority: 3,
      requestTypeId: ID_TIPO_CHAMADO, 
      statusId: ID_STATUS_OFFLINE,  // Usando o status "Unify Offline"    
      customerId: ID_CLIENTE_PADRAO,
      requesterName: `Monitoramento - ${nomeGateway}`,
      requesterEmail: "ti@qualiport.com.br"
    };

    const response = await axios.post('https://api.auvo.com.br/v2/tickets', ticketData, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    const ticketId = response.data?.result?.ticketID || response.data?.result?.id;

    if (ticketId) {
      console.log(`[${getHorario()}] [Sucesso] Ticket #${ticketId} aberto para: ${nomeGateway}`);
      offlineGatewaysCache.set(gateway.id, { ticketId: ticketId, openedAt: Date.now() });
    } else {
      console.log(`[${getHorario()}] [Atenção] Ticket aberto, mas não foi possível capturar o ID da resposta.`);
      offlineGatewaysCache.set(gateway.id, { ticketId: null, openedAt: Date.now() });
    }
    
    pendingValidationCache.delete(gateway.id);

  } catch (error) {
    console.error(`[${getHorario()}] [Erro] Falha ao abrir ticket para ${nomeGateway}:`, error.message);
  }
}

async function updateAuvoTicket(ticketId, nomeGateway, tempoOfflineMs) {
  const token = await getAuvoToken();
  const tempoFormatado = formatarTempoOffline(tempoOfflineMs);
  const horarioRecuperacao = getHorario();
  
  // ===============================================
  // 1. ALTERA O STATUS DO TICKET (PATCH)
  // ===============================================
  try {
    await axios.patch(`https://api.auvo.com.br/v2/tickets/${ticketId}`, {
      statusId: ID_STATUS_ONLINE // Muda para o status "Unify Online"
    }, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    console.log(`[${getHorario()}] [Sucesso] Ticket #${ticketId} movido para status "Unify Online".`);
  } catch (error) {
    const detalheErro = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error(`[${getHorario()}] [Erro no Status] Status ${error.response?.status}. Detalhe: ${detalheErro}`);
  }

  // ===============================================
  // 2. ADICIONA A NOTA COM O TEMPO OFFLINE
  // ===============================================
  try {
    await axios.post(`https://api.auvo.com.br/v2/tickets/${ticketId}/notes`, {
      note: `Equipamento normalizado às ${horarioRecuperacao}. O gateway ficou offline por um período total de ${tempoFormatado}.`
    }, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    console.log(`[${getHorario()}] [Sucesso] Nota com o tempo de inatividade inserida no ticket #${ticketId}.`);
  } catch (error) {
    const detalheErro = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error(`[${getHorario()}] [Erro na Nota] Status ${error.response?.status}. Detalhe: ${detalheErro}`);
  }
}

// ==========================================
// 4. LÓGICA PRINCIPAL (MONITORAMENTO)
// ==========================================

async function checkUnifiStatus() {
  console.log(`\n[${getHorario()}] [UniFi] 📡 Iniciando consulta de Gateways...`);
  
  try {
    const response = await axios.get(UNIFI_API_URL, {
      headers: { 'X-API-KEY': UNIFI_API_KEY, 'Accept': 'application/json' },
      timeout: 10000 
    });

    const gateways = response.data.data || [];
    
    const promessas = gateways.map(async (gateway) => {
      const estado = (gateway.reportedState?.state || '').toLowerCase();
      const nome = gateway.reportedState?.name || 'Desconhecido';
      
      // Validação de Implantação
      const nomeUpper = nome.toUpperCase();
      const isImplantacao = nomeUpper.includes('IMPLATACAO') || 
                            nomeUpper.includes('IMPLANTACAO') || 
                            nomeUpper.includes('IMPLANTAÇÃO');

      const isOffline = (estado === 'disconnected' || estado === 'offline') && !isImplantacao;

      if (isImplantacao && (estado === 'disconnected' || estado === 'offline')) {
        console.log(`[${getHorario()}] [Ignorado] 🚧 ${nome} está offline, mas em fase de implantação.`);
      }

      if (isOffline) {
        // --- CENÁRIO OFFLINE ---
        if (offlineGatewaysCache.has(gateway.id)) {
          return; // Ticket já aberto
        } else if (pendingValidationCache.has(gateway.id)) {
          console.log(`[${getHorario()}] [Confirmado] 🔴 ${nome} validado como offline. Abrindo ticket...`);
          await openAuvoTicket(gateway);
        } else {
          console.log(`[${getHorario()}] [Atenção] 🟡 ${nome} detectado offline. Aguardando validação de 5 minutos...`);
          pendingValidationCache.add(gateway.id);
        }
      } else {
        // --- CENÁRIO ONLINE ---
        if (pendingValidationCache.has(gateway.id)) {
          console.log(`[${getHorario()}] [Recuperação Rápida] 🟢 ${nome} voltou antes da abertura do ticket!`);
          pendingValidationCache.delete(gateway.id);
        }
        
        if (offlineGatewaysCache.has(gateway.id)) {
          const cacheData = offlineGatewaysCache.get(gateway.id);
          const tempoOfflineMs = Date.now() - cacheData.openedAt;

          if (cacheData.ticketId) {
            console.log(`[${getHorario()}] [Recuperação] 🟢 ${nome} voltou! Atualizando o ticket #${cacheData.ticketId}...`);
            await updateAuvoTicket(cacheData.ticketId, nome, tempoOfflineMs);
          } else {
            console.log(`[${getHorario()}] [Recuperação] 🟢 ${nome} voltou, mas não possui ID registrado para atualizar o ticket.`);
          }
          
          offlineGatewaysCache.delete(gateway.id); // Remove do cache de quedas
        }
      }
    });

    await Promise.all(promessas);
    console.log(`[${getHorario()}] [Resumo] Processamento concluído com sucesso.`);

  } catch (error) {
    console.error(`[${getHorario()}] [Erro no Ciclo]:`, error.message);
  }
}

// Início
console.log('Monitoramento Iniciado...');
checkUnifiStatus();
cron.schedule('*/5 * * * *', () => checkUnifiStatus());
