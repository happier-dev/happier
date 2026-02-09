import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function normalizeTokenMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    out[key] = value;
  }
  return out;
}

function addTokenMaps(base, delta) {
  const out = { ...base };
  for (const [key, value] of Object.entries(delta)) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

function summarizeProviderTokenLedgerByProviderAndModel(entries) {
  const acc = new Map();
  for (const entry of entries) {
    const providerId = typeof entry?.providerId === 'string' ? entry.providerId.trim() : '';
    if (!providerId) continue;
    const modelId = typeof entry?.modelId === 'string' && entry.modelId.trim().length > 0 ? entry.modelId.trim() : null;
    const key = `${providerId}::${modelId ?? 'null'}`;
    const normalizedTokens = normalizeTokenMap(entry?.tokens);
    const current = acc.get(key) ?? {
      providerId,
      modelId,
      entries: 0,
      tokens: {},
    };
    current.entries += 1;
    current.tokens = addTokenMaps(current.tokens, normalizedTokens);
    acc.set(key, current);
  }
  return [...acc.values()].sort((a, b) => {
    if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
    return (a.modelId ?? '').localeCompare(b.modelId ?? '');
  });
}

function summarizeProviderTokenLedgerTotals(entries) {
  let count = 0;
  let totals = {};
  for (const entry of entries) {
    totals = addTokenMaps(totals, normalizeTokenMap(entry?.tokens));
    count += 1;
  }
  return { entries: count, tokens: totals };
}

function usage() {
  console.error(
    [
      'Usage:',
      '  yarn providers:token-ledger:summary [--file <path>]',
      '',
      'Defaults:',
      '  --file uses HAPPIER_E2E_PROVIDER_TOKEN_LEDGER_PATH (or HAPPY_*) when set,',
      '  otherwise defaults to packages/tests/.project/logs/e2e latest run ledger path when provided explicitly.',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let filePath = (process.env.HAPPIER_E2E_PROVIDER_TOKEN_LEDGER_PATH ?? process.env.HAPPY_E2E_PROVIDER_TOKEN_LEDGER_PATH ?? '').trim();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file') {
      const next = args[i + 1];
      if (!next) throw new Error('Missing value for --file');
      filePath = next;
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true, filePath: '' };
    throw new Error(`Unknown arg: ${arg}`);
  }
  if (!filePath) throw new Error('Missing ledger path. Provide --file or HAPPIER_E2E_PROVIDER_TOKEN_LEDGER_PATH.');
  return { help: false, filePath };
}

function formatTokenMap(tokens) {
  const keys = Object.keys(tokens).sort();
  if (keys.length === 0) return '-';
  return keys.map((key) => `${key}=${tokens[key]}`).join(', ');
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (parsed.help) {
    usage();
    process.exit(0);
  }

  const filePath = resolve(parsed.filePath);
  let json;
  try {
    const raw = await readFile(filePath, 'utf8');
    json = JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to read token ledger: ${filePath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const summary = summarizeProviderTokenLedgerByProviderAndModel(entries);
  const totals = summarizeProviderTokenLedgerTotals(entries);

  console.log(`Token ledger: ${filePath}`);
  console.log(`Run id: ${typeof json?.runId === 'string' ? json.runId : 'unknown'}`);
  console.log(`Entries: ${totals.entries}`);
  console.log(`Totals: ${formatTokenMap(totals.tokens)}`);
  console.log('');
  console.log('By provider/model:');
  for (const row of summary) {
    console.log(
      `- ${row.providerId} | ${row.modelId ?? 'unknown-model'} | entries=${row.entries} | ${formatTokenMap(row.tokens)}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
