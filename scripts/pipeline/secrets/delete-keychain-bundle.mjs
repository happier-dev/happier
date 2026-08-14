// @ts-check

import { execFileSync } from 'node:child_process';

import { assertSecurityCliAvailable } from './security-cli.mjs';

/**
 * Deletes one macOS Keychain generic-password bundle.
 *
 * @param {{ service: string; account?: string }} opts
 */
export function deleteKeychainBundle({ service, account }) {
  assertSecurityCliAvailable();

  const args = ['delete-generic-password', '-s', service];
  if (account) args.push('-a', account);

  execFileSync('security', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}
