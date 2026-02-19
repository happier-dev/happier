// @ts-check

import { execFileSync } from 'node:child_process';

/**
 * Reads the Keychain bundle secret for the pipeline.
 *
 * @param {{ service: string; account?: string }} opts
 * @returns {Record<string, string>}
 */
export function readKeychainBundle({ service, account }) {
  const args = ['find-generic-password', '-s', service, '-w'];
  if (account) args.push('-a', account);

  const raw = execFileSync('security', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  const text = String(raw ?? '').trim();
  if (!text) return {};

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Keychain bundle is not valid JSON for service '${service}'.`);
  }

  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

