// @ts-check

import { readKeychainBundle } from './read-keychain-bundle.mjs';

/**
 * @param {{
 *   baseEnv: Record<string, string>;
 *   secretsSource: 'auto' | 'env' | 'keychain';
 *   keychainService: string;
 *   keychainAccount?: string;
 * }} opts
 * @returns {{ env: Record<string, string>; usedKeychain: boolean }}
 */
export function loadSecrets({ baseEnv, secretsSource, keychainService, keychainAccount }) {
  if (secretsSource === 'env') {
    return { env: baseEnv, usedKeychain: false };
  }

  if (secretsSource === 'keychain' || secretsSource === 'auto') {
    let bundle = {};
    try {
      bundle = readKeychainBundle({ service: keychainService, account: keychainAccount });
    } catch (err) {
      if (secretsSource === 'keychain') throw err;
      bundle = {};
    }

    // Env-file/process env should override Keychain values for fast iteration.
    const merged = { ...bundle, ...baseEnv };
    return { env: merged, usedKeychain: Object.keys(bundle).length > 0 };
  }

  return { env: baseEnv, usedKeychain: false };
}

