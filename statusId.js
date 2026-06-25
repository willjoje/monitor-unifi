import axios from 'axios';

const AUVO_API_KEY = '6Dg9SRzN3EivhKG1rZwjRYKQlfbntajh';
const AUVO_API_TOKEN = '6Dg9SRzN3Ejr8tmzIYkpTZB352cUqVK';

async function listarStatusCorreto() {
  try {
    const login = await axios.post('https://api.auvo.com.br/v2/login', {
      apiKey: AUVO_API_KEY,
      apiToken: AUVO_API_TOKEN
    });
    const token = login.data.result.accessToken;

    // Usando o endpoint exato que você pescou na doc: /v2/tickets/status
    const res = await axios.get('https://api.auvo.com.br/v2/tickets/status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log("=== IDs DE STATUS DE TICKETS ===");
    console.log(JSON.stringify(res.data.result, null, 2));

  } catch (error) {
    console.error("Erro final:", error.response?.data || error.message);
  }
}

listarStatusCorreto();