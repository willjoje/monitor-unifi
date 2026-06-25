import axios from 'axios';
import cron from 'node-cron';
import cliProgress from 'cli-progress';
import chalk from 'chalk';

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const UNIFI_API_URL = 'https://api.ui.com/v1/hosts';
const UNIFI_API_KEY = '4aIypKqJoWGE9YJnSywr7gHTsuuWCcOi';

const AUVO_API_KEY = '6Dg9SRzN3EivhKG1rZwjRYKQlfbntajh';
const AUVO_API_TOKEN = '6Dg9SRzN3Ejr8tmzIYkpTZB352cUqVK';

const ID_STATUS_OFFLINE = 108504; 
const ID_STATUS_ONLINE = 108505; 
const ID_CLIENTE_PADRAO = 14248700;

let auvoAccessToken = null;
let auvoTokenExpiration = 0;

const offlineGatewaysCache = new Map();
const pendingValidationCache = new Set();
const promisesEmAndamento = new Set();

// ==========================================
// FUNÇÕES ÚTEIS
// ==========================================
function getHorario() {
  return new Date().toLocaleTimeString('pt-BR');
}

// ==========================================
// FUNÇÕES DE API
// ==========================================

async function getAuvoToken() {
  const agora = Date.now();
  if (auvoAccessToken && agora < auvoTokenExpiration - (2 * 60 * 1000)) return auvoAccessToken;
  
  const response = await axios.post('https://api.auvo.com.br/v2/login', { 
    apiKey: AUVO_API_KEY, 
    apiToken: AUVO_API_TOKEN 
  });
  auvoAccessToken = response.data.result.accessToken;
  auvoTokenExpiration = agora + (30 * 60 * 1000);
  return auvoAccessToken;
}

// Abre o ticket com status Unifi Offline
async function openAuvoTicket(gateway, logsDoCiclo) {
  const nomeGateway = gateway.reportedState?.name || 'Desconhecido';
  const token = await getAuvoToken();
  
  const ticketData = {
    customerId: ID_CLIENTE_PADRAO,
    title: `Alerta: Gateway ${nomeGateway} Offline`,
    description: `O dispositivo ${nomeGateway} perdeu conexão com o Site Manager.`,
    statusId: ID_STATUS_OFFLINE,
    priority: 3
  };

  try {
    const response = await axios.post('https://api.auvo.com.br/v2/tickets', ticketData, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    const taskId = response.data.result.id;
    offlineGatewaysCache.set(gateway.id, { taskId, name: nomeGateway, openedAt: Date.now() });
    pendingValidationCache.delete(gateway.id);
    
    logsDoCiclo.push(chalk.red(`[!] Ticket #${taskId} aberto para ${nomeGateway}`));
  } catch (error) {
    logsDoCiclo.push(chalk.bgRed.white(`[Erro Abertura] Falha ao abrir ticket para ${nomeGateway}: ${error.message}`));
  }
}

// APENAS atualiza o status para Unifi Online (sem adicionar notas)
async function updateAuvoTicket(cacheData, nomeGateway, logsDoCiclo) {
  const token = await getAuvoToken();
  
  try {
    await axios.patch(`https://api.auvo.com.br/v2/tickets/${cacheData.taskId}`, 
      { statusId: ID_STATUS_ONLINE }, 
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    
    logsDoCiclo.push(chalk.green(`[✓] Ticket #${cacheData.taskId} (${nomeGateway}) atualizado para Unifi Online.`));
  } catch (error) {
    logsDoCiclo.push(chalk.bgRed.white(`[Erro Atualização] Ticket #${cacheData.taskId}: ${error.message}`));
  }
}

// ==========================================
// LÓGICA DE MONITORAMENTO E VISUALIZAÇÃO
// ==========================================

async function checkUnifiStatus() {
  if (promisesEmAndamento.size > 0) return;
  promisesEmAndamento.add('running');
  
  console.log(chalk.cyan(`\n=================================================`));
  console.log(chalk.cyan.bold(`📡 [${getHorario()}] INICIANDO CICLO DE VARREDURA`));
  console.log(chalk.cyan(`=================================================`));

  try {
    const response = await axios.get(UNIFI_API_URL, { headers: { 'X-API-KEY': UNIFI_API_KEY } });
    const todosGateways = response.data.data || [];
    
    // FILTRO: Remove todos os gateways que contenham a palavra "IMPLANTACAO" (ignorando maiúsculas/minúsculas)
    const gateways = todosGateways.filter(gw => {
      const nome = gw.reportedState?.name || '';
      return !nome.toUpperCase().includes('IMPLANTACAO');
    });

    const totalGateways = gateways.length;

    if (totalGateways === 0) {
      console.log(chalk.yellow("Nenhum gateway monitorável encontrado na controladora."));
      promisesEmAndamento.delete('running');
      return;
    }

    const progressBar = new cliProgress.SingleBar({
      format: 'Progresso |' + chalk.blue('{bar}') + '| {percentage}% || {value}/{total} Gateways',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });

    progressBar.start(totalGateways, 0);

    let countOnline = 0;
    let countOffline = 0;
    const logsDoCiclo = []; 

    for (const gateway of gateways) {
      const isOffline = (gateway.reportedState?.state === 'offline' || gateway.reportedState?.state === 'disconnected');
      
      if (isOffline) {
        countOffline++;
        if (!offlineGatewaysCache.has(gateway.id)) {
          // Processa abertura aguardando os 5 minutos de validação
          if (pendingValidationCache.has(gateway.id)) {
            await openAuvoTicket(gateway, logsDoCiclo);
          } else {
            pendingValidationCache.add(gateway.id);
          }
        } else {
          // CHECAGEM DE 1 HORA (3.600.000 ms)
          const cacheData = offlineGatewaysCache.get(gateway.id);
          const tempoOffline = Date.now() - cacheData.openedAt;
          
          if (tempoOffline > 3600000) {
            // Passou de 1 hora. Remove da memória para não tentar atualizar mais.
            offlineGatewaysCache.delete(gateway.id);
            logsDoCiclo.push(chalk.yellow(`[Tempo Limite] ${cacheData.name} offline há > 1h. Ticket #${cacheData.taskId} ignorado p/ ação manual.`));
          }
        }
      } else {
        countOnline++;
        if (offlineGatewaysCache.has(gateway.id)) {
          // Voltou antes de 1 hora: altera status para Online
          const cacheData = offlineGatewaysCache.get(gateway.id);
          await updateAuvoTicket(cacheData, gateway.reportedState.name, logsDoCiclo);
          offlineGatewaysCache.delete(gateway.id);
        }
        pendingValidationCache.delete(gateway.id);
      }
      
      progressBar.increment();
    }

    progressBar.stop();

    // ==========================================
    // IMPRESSÃO DOS EVENTOS DO CICLO
    // ==========================================
    if (logsDoCiclo.length > 0) {
      console.log(); 
      logsDoCiclo.forEach(log => console.log(log));
    }

    // ==========================================
    // DASHBOARD RESUMO DO CICLO
    // ==========================================
    console.log(chalk.bold(`\n📊 RESUMO DO CICLO:`));
    console.log(chalk.green(`🟢 Online/Conectados: ${countOnline}`));
    console.log(chalk.red(`🔴 Offline/Desconectados: ${countOffline}`));
    console.log(chalk.yellow(`🟡 Validações Pendentes (Aguardando 5 min): ${pendingValidationCache.size}`));
    
    if (offlineGatewaysCache.size > 0) {
      console.log(chalk.red.bold(`\n⚠️  TICKETS ABERTOS NO MOMENTO (Observação de 1h):`));
      const tabelaOffline = [];
      
      offlineGatewaysCache.forEach((data) => {
        const tempoCaiu = new Date(data.openedAt).toLocaleTimeString('pt-BR');
        tabelaOffline.push({
          'Gateway': data.name,
          'Ticket Auvo': `#${data.taskId}`,
          'Caiu às': tempoCaiu
        });
      });
      
      console.table(tabelaOffline);
    } else {
      console.log(chalk.green(`\n✨ Nenhum ticket aberto em janela de observação.`));
    }

  } catch (e) {
    console.log(chalk.bgRed.white(`\n❌ ERRO FATAL NO CICLO: ${e.message}`));
  } finally {
    promisesEmAndamento.delete('running');
  }
}

// Executa a primeira vez imediatamente
checkUnifiStatus();

// Agenda para rodar a cada 5 minutos
cron.schedule('*/5 * * * *', () => checkUnifiStatus());