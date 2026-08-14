// @ts-check

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[a-f0-9]{40}$/u;

/** @param {unknown} raw */
function normalizeUrl(raw) {
  const url = new URL(String(raw ?? '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Loaded revision URL must use http or https');
  return url.toString();
}

/** @param {unknown} raw */
function normalizeExpectedSha(raw) {
  const value = String(raw ?? '').trim();
  if (!FULL_SHA.test(value)) throw new Error('Expected source SHA must be 40 lowercase hexadecimal characters');
  return value;
}

/**
 * @param {{
 *   url: string;
 *   expectedSourceSha: string;
 *   attempts?: number;
 *   intervalMs?: number;
 *   fetchImpl?: typeof fetch;
 *   sleep?: (milliseconds: number) => Promise<void>;
 * }} input
 */
export async function verifyLoadedReleaseRevision(input) {
  const url = normalizeUrl(input.url);
  const expectedSourceSha = normalizeExpectedSha(input.expectedSourceSha);
  const attempts = input.attempts ?? 30;
  const intervalMs = input.intervalMs ?? 10_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) throw new Error('Attempts must be between 1 and 120');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error('Interval must be between 0 and 60000 ms');
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastObserved = 'no response';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        lastObserved = `HTTP ${response.status}`;
      } else {
        const payload = await response.json();
        const sourceSha = payload && typeof payload === 'object' && 'source_sha' in payload && typeof payload.source_sha === 'string'
          ? payload.source_sha
          : '';
        lastObserved = sourceSha || 'missing source_sha';
        if (sourceSha === expectedSourceSha) return { url, sourceSha, attempts: attempt };
      }
    } catch (error) {
      lastObserved = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`Loaded runtime did not report the expected source SHA ${expectedSourceSha}; last observed: ${lastObserved}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      'expected-source-sha': { type: 'string' },
      attempts: { type: 'string', default: '30' },
      'interval-ms': { type: 'string', default: '10000' },
    },
    allowPositionals: false,
  });
  const result = await verifyLoadedReleaseRevision({
    url: String(values.url ?? ''),
    expectedSourceSha: String(values['expected-source-sha'] ?? ''),
    attempts: Number(values.attempts),
    intervalMs: Number(values['interval-ms']),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
