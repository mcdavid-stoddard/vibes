const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const MULTISIG = "0x8a06c7c7F7f7c0c5aC2c05537afeb9A086Bb6BC4".toLowerCase();
const CHIA_ADDRESS = "xch1mwfnmxkf5tup5myd8na7w3xuv6d9kg3r4827uf376arj34nrsa4qw8xv5x";
const CHIA_API = `https://edge.silicon.net/v1/spacescan/address/token-transactions/${CHIA_ADDRESS}`;

const EVM_CHAINS = {
  ethereum: {
    rpc: "https://eth-mainnet.g.alchemy.com/v2/YIySSKWUU-ZiUl29cQHLd",
    name: "Ethereum",
    explorer: "https://etherscan.io",
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  arbitrum: {
    rpc: "https://arb-mainnet.g.alchemy.com/v2/YIySSKWUU-ZiUl29cQHLd",
    name: "Arbitrum",
    explorer: "https://arbiscan.io",
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  base: {
    rpc: "https://base-mainnet.g.alchemy.com/v2/YIySSKWUU-ZiUl29cQHLd",
    name: "Base",
    explorer: "https://basescan.org",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
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

// ERC20 Transfer event signature
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Track last processed block/tx per chain
const lastBlocks = {};
let lastChiaTimestamp = null;

async function rpcCall(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function getBlockNumber(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", []);
  return parseInt(hex, 16);
}

async function getLogs(rpc, fromBlock, toBlock, address, topics) {
  return rpcCall(rpc, "eth_getLogs", [{
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
    address,
    topics,
  }]);
}

function decodeTransferAmount(data) {
  return BigInt(data) / BigInt(1e6); // USDC has 6 decimals
}

function decodeAddress(topic) {
  return "0x" + topic.slice(-40);
}

function getEmojis(amount) {
  if (amount >= 100000) return "🚨🚨🚨🚨🚨";
  if (amount >= 10000) return "🦍🦍🦍🦍🦍";
  if (amount >= 1000) return "🐋🐋🐋🐋🐋";
  if (amount >= 10) return ":troll::troll::troll:";
  return "";
}

// Track running total across all chains
let totalDepositsAllChains = 0;

const TOTAL_API = "https://script.google.com/macros/s/AKfycbza5Cy5qYAa2n0UaJ9o3ZKKtuHv-nS7tECGKIApb2shfY0rqjkgu7LFtwVfQjXIf1BG/exec";

async function fetchTotalDeposits() {
  try {
    const res = await fetch(TOTAL_API);
    const json = await res.json();
    totalDepositsAllChains = json.total || 0;
    console.log(`📊 Initialized total deposits: ${totalDepositsAllChains.toLocaleString()}`);
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

async function checkChain(chainId, chain) {
  try {
    const currentBlock = await getBlockNumber(chain.rpc);
    
    // Initialize or use last block (look back 10 blocks on first run)
    if (!lastBlocks[chainId]) {
      lastBlocks[chainId] = currentBlock - 10;
    }
    
    const fromBlock = lastBlocks[chainId] + 1;
    if (fromBlock > currentBlock) return;
    
    // Get USDC transfers TO our multisig
    const logs = await getLogs(
      chain.rpc,
      fromBlock,
      currentBlock,
      chain.usdc,
      [
        TRANSFER_TOPIC,
        null,
        "0x000000000000000000000000" + MULTISIG.slice(2),
      ]
    );
    
    for (const log of logs) {
      const from = decodeAddress(log.topics[1]);
      const amount = decodeTransferAmount(log.data);
      const txHash = log.transactionHash;
      const emojis = getEmojis(Number(amount));
      
      // Update running total
      totalDepositsAllChains += Number(amount);
      
      const message = [
        emojis,
        `*New Deposit on ${chain.name}!*`,
        `• From: \`${from}\``,
        `• Amount: *${amount.toLocaleString()} USDC*`,
        `• Token: USDC`,
        `• Tx: ${chain.explorer}/tx/${txHash}`,
        ``,
        `📊 *Total Deposits (All Chains): ${totalDepositsAllChains.toLocaleString()}*`,
        emojis,
      ].filter(Boolean).join("\n");
      
      await sendSlackMessage(message);
      console.log(`[${chain.name}] Deposit: ${amount} USDC from ${from}`);
    }
    
    lastBlocks[chainId] = currentBlock;
  } catch (err) {
    console.error(`[${chainId}] Error:`, err.message);
  }
}

async function checkChia() {
  try {
    const res = await fetch(CHIA_API);
    const json = await res.json();
    
    if (!json.success || !json.data?.received_transactions?.transactions) {
      console.log("[Chia] No transactions or API error");
      return;
    }
    
    const transactions = json.data.received_transactions.transactions;
    
    // On first run, just record the latest timestamp
    if (!lastChiaTimestamp && transactions.length > 0) {
      lastChiaTimestamp = transactions[0].time;
      console.log(`[Chia] Initialized with latest tx at ${lastChiaTimestamp}`);
      return;
    }
    
    // Check for new transactions (newer than lastChiaTimestamp)
    for (const tx of transactions) {
      if (new Date(tx.time) <= new Date(lastChiaTimestamp)) break;
      
      const token = CHIA_TOKENS[tx.asset_id];
      if (!token) continue;
      
      const amount = tx.token_amount;
      const from = tx.from;
      const emojis = getEmojis(Number(amount));
      
      // Update running total
      totalDepositsAllChains += Number(amount);
      
      const message = [
        emojis,
        `*New Deposit on Chia!*`,
        `• From: \`${from}\``,
        `• Amount: *${amount.toLocaleString()} ${token.symbol}*`,
        `• Token: ${token.name}`,
        `• Tx: https://www.spacescan.io/coin/${tx.coin_id}`,
        ``,
        `📊 *Total Deposits (All Chains): ${totalDepositsAllChains.toLocaleString()}*`,
        emojis,
      ].filter(Boolean).join("\n");
      
      await sendSlackMessage(message);
      console.log(`[Chia] Deposit: ${amount} ${token.symbol} from ${from}`);
    }
    
    // Update last timestamp
    if (transactions.length > 0) {
      lastChiaTimestamp = transactions[0].time;
    }
  } catch (err) {
    console.error(`[Chia] Error:`, err.message);
  }
}

async function poll() {
  console.log("Checking for deposits...");
  await Promise.all([
    ...Object.entries(EVM_CHAINS).map(([id, chain]) => checkChain(id, chain)),
    checkChia(),
  ]);
}

// Poll every 15 seconds
console.log("🚀 Deposit bot started");
console.log(`Watching EVM: ${MULTISIG}`);
console.log(`Watching Chia: ${CHIA_ADDRESS}`);

// Initialize total from Google Sheet, then start polling
fetchTotalDeposits().then(() => {
  poll();
  setInterval(poll, 15000);
});
