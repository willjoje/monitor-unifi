import axios from 'axios';
import cron from 'node-cron';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import googleapis from 'googleapis';
const { google } = googleapis;

// ==========================================
// CONFIGURAÇÕES DE API
// ==========================================
const UNIFI_API_URL = 'https://api.ui.com/v1/hosts';
const UNIFI_API_KEY = '4aIypKqJoWGE9YJnSywr7gHTsuuWCcOi';

const AUVO_API_KEY = '6Dg9SRzN3EivhKG1rZwjRYKQlfbntajh';
const AUVO_API_TOKEN = '6Dg9SRzN3Ejr8tmzIYkpTZB352cUqVK';

const ID_STATUS_OFFLINE = 108504; 
const ID_STATUS_ONLINE = 108505; 
const ID_CLIENTE_PADRAO = 14248700; // Cliente Teste caso não encontre na planilha

// ==========================================
// CONFIGURAÇÃO SEGURA DO GOOGLE SHEETS
// ==========================================
// Substitui pelo ID que está na URL da tua planilha: https://docs.google.com/spreadsheets/d/ID_AQUI/edit
const ID_DA_PLANILHA = '1zoJ3r3CTik6ceDzcaR-TH0bnWbdwjKGYTRyK6x8yS70'; 
const NOME_DA_ABA = 'Página1'; // Nome exato da aba no Sheets (ex: 'Página1' ou 'Sheet1')

// ==========================================
// VARIÁVEIS DE CONTROLO E CACHE
// ==========================================
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

// ==========================================
// FUNÇÃO: LER PLANILHA PRIVADA (GOOGLE API)
// ==========================================
async function obterTabelaDaPlanilha() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: './credenciais-google.json', // Procura o ficheiro de chaves baixado do GCP
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: ID_DA_PLANILHA,
      range: `${NOME_DA_ABA}!A:C`, // Lê as colunas A (nomeGateway), B (nomeAuvo) e C (idAuvo)
    });

    const linhas = response.data.values;
    const mapa = [];

    if (!linhas || linhas.length <= 1) return [];

    // Começa em 1 para ignorar a linha de cabeçalho da planilha
    for (let i = 1; i < linhas.length; i++) {
      const colunas = linhas[i];
      if (colunas && colunas.length >= 3 && colunas[0].trim() !== '') {
        mapa.push({
          nomeGateway: colunas[0].trim(),
          nomeAuvo: colunas[1].trim(),
          idAuvo: parseInt(colunas[2].trim(), 10)
        });
      }
    }
    return mapa;
  } catch (error) {
    console.log(chalk.red(`[Erro Planilha] Falha segura ao ler dados do Sheets: ${error.message}`));
    return []; // Retorna array vazio para o ciclo de monitorização não quebrar
  }
}

// ==========================================
// FUNÇÕES DE MANIPULAÇÃO DE TICKETS
// ==========================================

async function openAuvoTicket(gateway, logsDoCiclo, tabelaLive) {
  const nomeGateway = gateway.reportedState?.name || 'Desconhecido';
  const token = await getAuvoToken();
  
  // Procura a linha correspondente na tabela obtida da planilha
  const linhaEncontrada = tabelaLive.find(linha => linha.nomeGateway === nomeGateway);
  const idDoCliente = linhaEncontrada ? linhaEncontrada.idAuvo : ID_CLIENTE_PADRAO;
  
  const ticketData = {
    customerId: idDoCliente,
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
    
    const destinoLog = linhaEncontrada ? linhaEncontrada.nomeAuvo : "Cliente Teste (Não listado no Sheets)";
    logsDoCiclo.push(chalk.red(`[!] Ticket #${taskId} aberto para ${nomeGateway} -> Destino: ${destinoLog}`));
  } catch (error) {
    logsDoCiclo.push(chalk.bgRed.white(`[Erro Abertura] Falha ao abrir ticket para ${nomeGateway}: ${error.message}`));
  }
}

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
// LÓGICA PRINCIPAL DE VERIFICAÇÃO
// ==========================================

async function checkUnifiStatus() {
  if (promisesEmAndamento.size > 0) return;
  promisesEmAndamento.add('running');
  
  console.log(chalk.cyan(`\n=================================================`));
  console.log(chalk.cyan.bold(`📡 [${getHorario()}] INICIANDO CICLO DE VARREDURA`));
  console.log(chalk.cyan(`=================================================`));

  try {
    // 1. Descarrega a versão mais recente da planilha de forma autenticada e segura
    const tabelaLive = await obterTabelaDaPlanilha();

    // 2. Procura os hosts no Unifi Site Manager
    const response = await axios.get(UNIFI_API_URL, { headers: { 'X-API-KEY': UNIFI_API_KEY } });
    const todosGateways = response.data.data || [];
    
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
          if (pendingValidationCache.has(gateway.id)) {
            // Envia a tabela atualizada para a função de abertura
            await openAuvoTicket(gateway, logsDoCiclo, tabelaLive);
          } else {
            pendingValidationCache.add(gateway.id);
          }
        } else {
          const cacheData = offlineGatewaysCache.get(gateway.id);
          const tempoOffline = Date.now() - cacheData.openedAt;
          
          if (tempoOffline > 3600000) {
            offlineGatewaysCache.delete(gateway.id);
            logsDoCiclo.push(chalk.yellow(`[Tempo Limite] ${cacheData.name} offline há > 1h. Ticket #${cacheData.taskId} ignorado p/ ação manual.`));
          }
        }
      } else {
        countOnline++;
        if (offlineGatewaysCache.has(gateway.id)) {
          const cacheData = offlineGatewaysCache.get(gateway.id);
          await updateAuvoTicket(cacheData, gateway.reportedState.name, logsDoCiclo);
          offlineGatewaysCache.delete(gateway.id);
        }
        pendingValidationCache.delete(gateway.id);
      }
      
      progressBar.increment();
    }

    progressBar.stop();

    if (logsDoCiclo.length > 0) {
      console.log(); 
      logsDoCiclo.forEach(log => console.log(log));
    }

    console.log(chalk.bold(`\n📊 RESUMO DO CICLO:`));
    console.log(chalk.green(`🟢 Online/Conectados: ${countOnline}`));
    console.log(chalk.red(`🔴 Offline/Desconectados: ${countOffline}`));
    console.log(chalk.yellow(`🟡 Validações Pendentes (Aguardando 5 min): ${pendingValidationCache.size}`));
    
    if (offlineGatewaysCache.size > 0) {
      console.log(chalk.red.bold(`\n⚠️  TICKETS ABERTOS NO MOMENTO (Observação de 1h):`));
      const tabelaOffline = [];
      offlineGatewaysCache.forEach((data) => {
        tabelaOffline.push({
          'Gateway': data.name,
          'Ticket Auvo': `#${data.taskId}`,
          'Caiu às': new Date(data.openedAt).toLocaleTimeString('pt-BR')
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

// Execução inicial imediata
checkUnifiStatus();

// Agendamento de 5 em 5 minutos
cron.schedule('*/5 * * * *', () => checkUnifiStatus());