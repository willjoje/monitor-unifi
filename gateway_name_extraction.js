import fs from 'fs';

// Usando as mesmas credenciais do seu script original
const UNIFI_API_URL = 'https://api.ui.com/v1/hosts';
const UNIFI_API_KEY = '4aIypKqJoWGE9YJnSywr7gHTsuuWCcOi';

async function gerarCsvUnifi() {
  try {
    console.log("1. Conectando à API do Unifi Site Manager...");

    const response = await fetch(UNIFI_API_URL, {
      method: 'GET',
      headers: {
        'X-API-KEY': UNIFI_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Erro HTTP ${response.status} - ${response.statusText}`);
    }

    const body = await response.json();
    const todosGateways = body.data || [];

    console.log(`\n=== TOTAL DE GATEWAYS ENCONTRADOS: ${todosGateways.length} ===`);
    console.log("2. Estruturando e gravando o arquivo CSV...");

    // Cabeçalho do CSV
    const cabecalho = '"idUnifi";"nomeGateway"\n';
    
    // Varre os gateways para montar as linhas
    const linhas = todosGateways.map(gw => {
      // Pega o nome do jeito exato que o seu script de monitoramento lê
      const nomeGateway = (gw.reportedState?.name || 'Desconhecido').replace(/"/g, '""'); 
      const idUnifi = gw.id || 'Sem ID';
      
      return `"${idUnifi}";"${nomeGateway}"`;
    }).join('\n');

    // '\ufeff' garante que o Excel reconheça a codificação UTF-8 corretamente
    const conteudoCompleto = '\ufeff' + cabecalho + linhas;

    // Grava o arquivo na mesma pasta do script
    fs.writeFileSync('gateways_unifi.csv', conteudoCompleto, 'utf-8');

    console.log("\n✅ Arquivo 'gateways_unifi.csv' gerado com sucesso!");
    console.log("💡 Agora você tem os nomes EXATOS para preencher a coluna nomeGateway na sua tabela de clientes do Auvo!");

  } catch (error) {
    console.log("\n❌ FALHA AO GERAR CSV DO UNIFI");
    console.log("Motivo:", error.message);
  }
}

gerarCsvUnifi();