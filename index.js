const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const MULTISIG = "0x8a06c7c7F7f7c0c5aC2c05537afeb9A086Bb6BC4".toLowerCase();
const CHIA_ADDRESS = "xch1mwfnmxkf5tup5myd8na7w3xuv6d9kg3r4827uf376arj34nrsa4qw8xv5x";
const COINSET_API = "https://api.coinset.org";

// Base total includes fiat transactions + accounting adjustments as of Feb 2026
const BASE_TOTAL_DEPOSITS = 334375.31;

const CAT2_MOD_HASH = "37bef360ee858133b69d595a906dc45d01af50379dad515eb9518abb7c1d2a7a";

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

// =====================================================
// CHIA CRYPTO UTILS (from CTO's getBalances.js)
// =====================================================

const BECH32M_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function hexToBytes(hex) {
  hex = hex.replace(/^0x/, "");
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return Buffer.from(bytes);
}

function bytesToHex(buf) {
  return Buffer.from(buf).toString("hex");
}

function sha256(data) {
  return crypto.createHash("sha256").update(Buffer.from(data)).digest();
}

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const result = [], maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) result.push((acc << (toBits - bits)) & maxv);
  return result;
}

function bech32mDecode(address) {
  const pos = address.lastIndexOf("1");
  const hrp = address.slice(0, pos).toLowerCase();
  const data = address.slice(pos + 1).toLowerCase();
  const values = [];
  for (const c of data) {
    const idx = BECH32M_CHARSET.indexOf(c);
    if (idx === -1) throw new Error("Invalid bech32m char");
    values.push(idx);
  }
  const hrpExpanded = bech32HrpExpand(hrp);
  if (bech32Polymod([...hrpExpanded, ...values]) !== BECH32M_CONST) {
    throw new Error("Invalid bech32m checksum");
  }
  return Buffer.from(convertBits(values.slice(0, -6), 5, 8, false));
}

function shatreeAtom(atom) {
  return sha256(Buffer.concat([Buffer.from([0x01]), Buffer.from(atom)]));
}

function shatreePair(left, right) {
  return sha256(Buffer.concat([Buffer.from([0x02]), Buffer.from(left), Buffer.from(right)]));
}

function curriedValuesTreeHash(args, c) {
  if (args.length === 0) return c.ONE;
  const quotedArg = shatreePair(c.Q, args[0]);
  const rest = curriedValuesTreeHash(args.slice(1), c);
  return shatreePair(c.C, shatreePair(quotedArg, shatreePair(rest, c.NIL)));
}

function curryAndTreehash(quotedMod, hashedArgs) {
  const c = {
    Q: shatreeAtom(Buffer.from([0x01])),
    C: shatreeAtom(Buffer.from([0x04])),
    A: shatreeAtom(Buffer.from([0x02])),
    ONE: shatreeAtom(Buffer.from([0x01])),
    NIL: shatreeAtom(Buffer.alloc(0)),
  };
  const curried = curriedValuesTreeHash(hashedArgs, c);
  return shatreePair(c.A, shatreePair(quotedMod, shatreePair(curried, c.NIL)));
}

function calculateCatPuzzleHash(innerPuzzleHash, assetId) {
  const modHash = hexToBytes(CAT2_MOD_HASH);
  const tailHash = hexToBytes(assetId);
  const Q = shatreeAtom(Buffer.from([0x01]));
  const quotedMod = shatreePair(Q, modHash);
  return curryAndTreehash(quotedMod, [
    shatreeAtom(modHash),
    shatreeAtom(tailHash),
    innerPuzzleHash, // already a tree hash
  ]);
}

function intToBytes(n) {
  if (n === 0) return Buffer.alloc(0);
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const buf = Buffer.from(hex, "hex");
  if (buf[0] & 0x80) return Buffer.concat([Buffer.from([0x00]), buf]);
  return buf;
}

function computeCoinName(coin) {
  const parent = hexToBytes(coin.parent_coin_info);
  const ph = hexToBytes(coin.puzzle_hash);
  const amt = intToBytes(coin.amount);
  return bytesToHex(sha256(Buffer.concat([parent, ph, amt])));
}

// =====================================================
// STATE
// =====================================================

let totalDepositsAllChains = 0;
// Track all coin names we've already seen so we only alert on new ones
let knownChiaCoinNames = new Set();
let chiaInitialized = false;
// Pre-computed CAT puzzle hashes (computed on startup)
let catPuzzleHashes = {}; // assetId -> hex puzzle hash

function getEmojis(amount) {
  if (amount >= 100000) return "🚨🚨🚨🚨🚨";
  if (amount >= 10000) return "🦍🦍🦍🦍🦍";
  if (amount >= 1000) return "🐋🐋🐋🐋🐋";
  if (amount >= 10) return ":troll::troll::troll:";
  return "";
}

function fetchTotalDeposits() {
  totalDepositsAllChains = BASE_TOTAL_DEPOSITS;
  console.log(`📊 Initialized total deposits from base: $${totalDepositsAllChains.toLocaleString()}`);
}

async function sendSlackMessage(text) {
  await fetch(SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// =====================================================
// EVM WEBHOOK (unchanged)
// =====================================================

app.post('/webhook/alchemy', async (req, res) => {
  try {
    console.log('Received ADDRESS_ACTIVITY webhook');
    const chainId = req.body.event?.network;
    const activity = req.body.event?.activity || [];

    for (const tx of activity) {
      if (tx.toAddress?.toLowerCase() !== MULTISIG) continue;

      const usdcAddress = USDC_CONTRACTS[chainId];
      if (!usdcAddress) continue;
      if (tx.rawContract?.address?.toLowerCase() !== usdcAddress) continue;

      const amount = parseFloat(tx.value) || 0;
      const from = tx.fromAddress;
      const txHash = tx.hash;
      const chainName = CHAIN_NAMES[chainId] || chainId;
      const explorer = CHAIN_EXPLORERS[chainId] || "https://etherscan.io";
      const emojis = getEmojis(amount);

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

      await sendSlackMessage(message);
      console.log(`[${chainName}] Deposit: ${amount} USDC from ${from}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send('Error');
  }
});

app.get('/', (req, res) => {
  res.send('Deposit bot running');
});

// =====================================================
// CHIA POLLING VIA COINSET (replaces Spacescan)
// =====================================================

async function fetchCoinRecords(puzzleHashHex) {
  const res = await fetch(`${COINSET_API}/get_coin_records_by_puzzle_hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      puzzle_hash: "0x" + puzzleHashHex,
      include_spent_coins: true,
    }),
  });
  if (!res.ok) throw new Error(`Coinset HTTP ${res.status}`);
  return res.json();
}

async function checkChia() {
  try {
    for (const [assetId, token] of Object.entries(CHIA_TOKENS)) {
      const puzzleHashHex = catPuzzleHashes[assetId];
      if (!puzzleHashHex) continue;

      const data = await fetchCoinRecords(puzzleHashHex);
      if (!data.success) {
        console.log(`[Chia] Coinset error for ${token.symbol}: ${data.error || "unknown"}`);
        continue;
      }

      const records = data.coin_records || [];

      // Build set of our own coin names (to filter consolidations)
      const ourCoinNames = new Set();
      for (const r of records) {
        ourCoinNames.add(computeCoinName(r.coin));
      }

      for (const record of records) {
        const coinName = computeCoinName(record.coin);

        // Skip if we already know about this coin
        if (knownChiaCoinNames.has(coinName)) continue;
        knownChiaCoinNames.add(coinName);

        // Skip consolidations (parent is one of our own coins)
        const parentId = record.coin.parent_coin_info.replace(/^0x/, "").toLowerCase();
        if (ourCoinNames.has(parentId)) continue;

        // On first run, just record existing coins — don't alert
        if (!chiaInitialized) continue;

        const amount = record.coin.amount / 1000; // CATs: 3 decimal places
        const emojis = getEmojis(amount);

        totalDepositsAllChains += amount;

        const message = [
          emojis,
          `*New Deposit on Chia!*`,
          `• Amount: *${amount.toLocaleString()} ${token.symbol}*`,
          `• Token: ${token.name}`,
          `• Coin: https://www.spacescan.io/coin/0x${coinName}`,
          ``,
          `📊 *Total Deposits (All Chains): $${totalDepositsAllChains.toLocaleString()}*`,
          emojis,
        ].filter(Boolean).join("\n");

        await sendSlackMessage(message);
        console.log(`[Chia] Deposit: ${amount} ${token.symbol}`);
      }
    }

    if (!chiaInitialized) {
      chiaInitialized = true;
      console.log(`[Chia] Initialized — tracking ${knownChiaCoinNames.size} existing coins`);
    }
  } catch (err) {
    console.error(`[Chia] Error:`, err.message);
  }
}

// =====================================================
// STARTUP
// =====================================================

const PORT = process.env.PORT || 3000;

async function start() {
  // Pre-compute CAT puzzle hashes
  const innerPuzzleHash = bech32mDecode(CHIA_ADDRESS);
  for (const assetId of Object.keys(CHIA_TOKENS)) {
    const ph = calculateCatPuzzleHash(innerPuzzleHash, assetId);
    catPuzzleHashes[assetId] = bytesToHex(ph);
    console.log(`[Chia] ${CHIA_TOKENS[assetId].symbol} puzzle hash: ${catPuzzleHashes[assetId]}`);
  }

  fetchTotalDeposits();

  app.listen(PORT, () => {
    console.log(`🚀 Deposit bot started on port ${PORT}`);
    console.log(`Watching EVM (via webhooks): ${MULTISIG}`);
    console.log(`Watching Chia (via Coinset polling): ${CHIA_ADDRESS}`);
  });

  // Poll Chia every 15 seconds
  checkChia();
  setInterval(checkChia, 15000);
}

start();
