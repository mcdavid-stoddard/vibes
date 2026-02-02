const express = require('express');
const app = express();
app.use(express.json());

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const MULTISIG = "0x8a06c7c7F7f7c0c5aC2c05537afeb9A086Bb6BC4".toLowerCase();
const CHIA_ADDRESS = "xch1mwfnmxkf5tup5myd8na7w3xuv6d9kg3r4827uf376arj34nrsa4qw8xv5x";
const CHIA_API = `https://edge.silicon.net/v1/spacescan/address/token-transactions/${CHIA_ADDRESS}`;
const TOTAL_API = "https://script.google.com/macros/s/AKfycbza5Cy5qYAa2n0UaJ9o3ZKKtuHv-nS7tECGKIApb2shfY0rqjkgu7LFtwVfQjXIf1BG/exec";

// USDC contract addresses per chain (using Alchemy's network format)
const USDC_CONTRACTS = {
  "ETH_MAINNET": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "ARB_MAINNET": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "BASE_MAINNET": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
};

const CHAIN_NAMES = {
  "ETH_MAINNET": "Ethereum",
  "ARB_MAINNET": "Arbitrum", 
  "BASE_MAINNET": "Base",
};

const CHAIN_EXPLORERS = {
  "ETH_MAINNET": "https://etherscan.io",
  "ARB_MAINNET": "https://arbiscan.io",
  "BASE_MAINNET": "https://basescan.org",
};

const CHIA_TOKENS = {
  "fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d": {
    symbol: "wUSDC.b",
    name: "Wrapped USDC",
    decimals: 3,
  },
  "ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac": {
    symbol: "BYC",
    name: "Bytecash",
    decimals: 3,
  },
};

// Track running total and Chia state
let totalDepositsAllChains = 0;
let lastChiaTimestamp = null;

function getEmojis(amount) {
  if (amount >= 100000) return "🚨🚨🚨🚨🚨";
  if (amount >= 10000) return "🦍🦍🦍🦍🦍";
  if (amount >= 1000) return "🐋🐋🐋🐋🐋";
  if (amount >= 10) return ":troll::troll::troll:";
  return "";
}

async function fetchTotalDeposits() {
  try {
    const res = await fetch(TOTAL_API);
    const json = await res.json();
    totalDepositsAllChains = json.total || 0;
    console.log(`📊 Initialized total deposits: $${totalDepositsAllChains.toLocaleString()}`);
  } catch (err) {
    console.error("Failed to fetch total deposits:", err.message);
    totalDepositsAllChains = 0;
  }
}

async function sendSlackMessage(text) {
  await fetch(SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// Webhook endpoint for Alchemy
app.post('/webhook/alchemy', async (req, res) => {
  try {
    console.log('Received ADDRESS_ACTIVITY webhook');
    
    // DEBUG LOGGING
    const chainId = req.body.event?.network;
    console.log('Chain ID from Alchemy:', chainId);
    
    const activity = req.body.event?.activity || [];
    console.log('Activity count:', activity.length);
    
    for (const tx of activity) {
      console.log('Processing tx:', JSON.stringify({
        toAddress: tx.toAddress,
        fromAddress: tx.fromAddress,
        rawContractAddress: tx.rawContract?.address,
        value: tx.value,
        asset: tx.asset
      }));
      
      // Only process incoming transfers to our multisig
      if (tx.toAddress?.toLowerCase() !== MULTISIG) {
        console.log('Skipping - toAddress mismatch. Got:', tx.toAddress?.toLowerCase(), 'Expected:', MULTISIG);
        continue;
      }
      
      // Only process USDC transfers
      const usdcAddress = USDC_CONTRACTS[chainId];
      if (!usdcAddress) {
        console.log('Skipping - unknown chain:', chainId, 'Known chains:', Object.keys(USDC_CONTRACTS));
        continue;
      }
      
      if (tx.rawContract?.address?.toLowerCase() !== usdcAddress) {
        console.log('Skipping - not USDC. Got:', tx.rawContract?.address?.toLowerCase(), 'Expected:', usdcAddress);
        continue;
      }
      
      const amount = parseFloat(tx.value) || 0;
      const from = tx.fromAddress;
      const txHash = tx.hash;
      const chainName = CHAIN_NAMES[chainId] || chainId;
      const explorer = CHAIN_EXPLORERS[chainId] || "https://etherscan.io";
      const emojis = getEmojis(amount);
      
      // Update running total
      totalDepositsAllChains += amount;
      
      const message = [
        emojis,
        `*New Deposit on ${chainName}!*`,
        `• From: \`${from}\``,
        `• Amount: *${amount.toLocaleString()} USDC*`,
        `• Token: USDC`,
        `• Tx: ${explorer}/tx/${txHash}`,
        ``,
        `📊 *Total Deposits (All Chains): $${totalDepositsAllChains.toLocaleString()}*`,
        emojis,
      ].filter(Boolean).join("\n");
      
      console.log('Sending Slack message for deposit:', amount, 'USDC');
      await sendSlackMessage(message);
      console.log(`[${chainName}] Deposit: ${amount} USDC from ${from}`);
    }
    
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send('Error');
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Deposit bot running');
});

// Chia polling (unchanged)
async function checkChia() {
  try {
    const res = await fetch(CHIA_API);
    const json = await res.json();
    
    if (!json.success || !json.data?.received_transactions?.transactions) {
      console.log("[Chia] No transactions or API error");
      return;
    }
    
    const transactions = json.data.received_transactions.transactions;
    
    if (!lastChiaTimestamp && transactions.length > 0) {
      lastChiaTimestamp = transactions[0].time;
      console.log(`[Chia] Initialized with latest tx at ${lastChiaTimestamp}`);
      return;
    }
    
    for (const tx of transactions) {
      if (new Date(tx.time) <= new Date(lastChiaTimestamp)) break;
      
      const token = CHIA_TOKENS[tx.asset_id];
      if (!token) continue;
      
      const amount = tx.token_amount;
      const from = tx.from;
      const emojis = getEmojis(Number(amount));
      
      totalDepositsAllChains += Number(amount);
      
      const message = [
        emojis,
        `*New Deposit on Chia!*`,
        `• From: \`${from}\``,
        `• Amount: *${amount.toLocaleString()} ${token.symbol}*`,
        `• Token: ${token.name}`,
        `• Tx: https://www.spacescan.io/coin/${tx.coin_id}`,
        ``,
        `📊 *Total Deposits (All Chains): $${totalDepositsAllChains.toLocaleString()}*`,
        emojis,
      ].filter(Boolean).join("\n");
      
      await sendSlackMessage(message);
      console.log(`[Chia] Deposit: ${amount} ${token.symbol} from ${from}`);
    }
    
    if (transactions.length > 0) {
      lastChiaTimestamp = transactions[0].time;
    }
  } catch (err) {
    console.error(`[Chia] Error:`, err.message);
  }
}

// Start server and Chia polling
const PORT = process.env.PORT || 3000;

async function start() {
  await fetchTotalDeposits();
  
  app.listen(PORT, () => {
    console.log(`🚀 Deposit bot started on port ${PORT}`);
    console.log(`Watching EVM (via webhooks): ${MULTISIG}`);
    console.log(`Watching Chia (polling): ${CHIA_ADDRESS}`);
  });
  
  // Poll Chia every 15 seconds
  checkChia();
  setInterval(checkChia, 15000);
}

start();
