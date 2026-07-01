import fs from 'fs';

const AUVO_API_KEY = '6Dg9SRzN3EivhKG1rZwjRYKQlfbntajh';
const AUVO_API_TOKEN = '6Dg9SRzN3Ejr8tmzIYkpTZB352cUqVK';

async function gerarCsvClientes() {
  try {
    console.log("1. Autenticando no Auvo...");
    
    const loginReq = await fetch('https://api.auvo.com.br/v2/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: AUVO_API_KEY, apiToken: AUVO_API_TOKEN })
    });
    
    const loginData = await loginReq.json();
    const token = loginData.result.accessToken;

    console.log("2. Buscando a lista completa de clientes...");

    const response = await fetch('https://api.auvo.com.br/v2/customers?pageSize=500', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Erro HTTP ${response.status} - ${response.statusText}`);
    }

    const body = await response.json();
    const listaClientes = body.result.entityList || [];

    console.log(`\n=== TOTAL DE CLIENTES ENCONTRADOS: ${listaClientes.length} ===`);
    console.log("3. Estruturando e gravando o arquivo CSV...");

    // Cabeçalho com as 3 colunas combinadas
    const cabecalho = '"nomeGateway";"nomeAuvo";"idAuvo"\n';
    
    // Transforma a lista de clientes nas linhas do CSV
    const linhas = listaClientes.map(cliente => {
      // Garante que se houver aspas no nome do cliente, elas não quebrem o CSV
      const nomeAuvo = (cliente.description || 'Sem Nome').replace(/"/g, '""'); 
      return `"NOME_AQUI";"${nomeAuvo}";"${cliente.id}"`;
    }).join('\n');

    // '\ufeff' garante que o Excel reconheça a codificação UTF-8 com acentos corretamente
    const conteudoCompleto = '\ufeff' + cabecalho + linhas;

    // Grava o arquivo na mesma pasta do script
    fs.writeFileSync('clientes_auvo.csv', conteudoCompleto, 'utf-8');

    console.log("\n✅ Arquivo 'clientes_auvo.csv' gerado com sucesso!");
    console.log("💡 Pronto! Só abrir no Excel ou Bloco de Notas, preencher a primeira coluna e usar de mapa.");

  } catch (error) {
    console.log("\n❌ FALHA AO GERAR CSV");
    console.log("Motivo:", error.message);
  }
}

gerarCsvClientes();