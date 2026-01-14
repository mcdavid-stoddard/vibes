const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const MULTISIG = "0x8a06c7c7F7f7c0c5aC2c05537afeb9A086Bb6BC4".toLowerCase();

const CHAINS = {
  ethereum: {
    rpc: "https://eth.llamarpc.com",
    name: "Ethereum",
    explorer: "https://etherscan.io",
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  arbitrum: {
    rpc: "https://arb1.arbitrum.io/rpc",
    name: "Arbitrum",
    explorer: "https://arbiscan.io",
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  base: {
    rpc: "https://mainnet.base.org",
    name: "Base",
    explorer: "https://basescan.org",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
};

// ERC20 Transfer event signature
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Track last processed block per chain
const lastBlocks = {};

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
  // data is hex string of uint256
  return BigInt(data) / BigInt(1e6); // USDC has 6 decimals
}

function decodeAddress(topic) {
  // address is in last 40 chars of 32-byte topic
  return "0x" + topic.slice(-40);
}

function getEmojis(amount) {
  if (amount >= 100000) return "🚨🚨🚨🚨🚨";
  if (amount >= 10000) return "🦍🦍🦍🦍🦍";
  if (amount >= 1000) return "🐋🐋🐋🐋🐋";
  if (amount >= 10) return "🐟🐟🐟🐟🐟";
  return "";
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
        null, // from (any)
        "0x000000000000000000000000" + MULTISIG.slice(2), // to (our multisig)
      ]
    );
    
    for (const log of logs) {
      const from = decodeAddress(log.topics[1]);
      const amount = decodeTransferAmount(log.data);
      const txHash = log.transactionHash;
      const emojis = getEmojis(Number(amount));
      
      const message = [
        emojis,
        `*New Deposit on ${chain.name}!*`,
        `• From: \`${from}\``,
        `• Amount: *${amount.toLocaleString()} USDC*`,
        `• Token: USDC`,
        `• Tx: ${chain.explorer}/tx/${txHash}`,
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

async function poll() {
  console.log("Checking for deposits...");
  await Promise.all(
    Object.entries(CHAINS).map(([id, chain]) => checkChain(id, chain))
  );
}

// Poll every 15 seconds
console.log("🚀 Deposit bot started");
console.log(`Watching: ${MULTISIG}`);
poll();
setInterval(poll, 15000);
