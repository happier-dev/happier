// @ts-check

import { execFileSync } from 'node:child_process';

/**
 * Writes (creates or updates) the Keychain bundle secret for the pipeline.
 *
 * The bundle is stored as a single Keychain generic password item:
 * - service = opts.service
 * - account = opts.account (optional)
 * - password = JSON string of { KEY: VALUE }
 *
 * @param {{ service: string; account?: string; bundle: Record<string, string> }} opts
 */
export function writeKeychainBundle({ service, account, bundle }) {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain secrets are only supported on macOS (darwin).');
  }

  const svc = String(service ?? '').trim();
  if (!svc) {
    throw new Error('--keychain-service is required');
  }

  /** @type {Record<string, string>} */
  const sanitized = {};
  for (const [k, v] of Object.entries(bundle ?? {})) {
    if (typeof v !== 'string') continue;
    sanitized[String(k)] = v;
  }

  const password = JSON.stringify(sanitized);
  const args = ['add-generic-password', '-U', '-s', svc];
  if (account) args.push('-a', String(account));
  args.push('-w', password);

  execFileSync('security', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

