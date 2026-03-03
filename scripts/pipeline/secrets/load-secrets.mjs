// @ts-check

import { readKeychainBundle } from './read-keychain-bundle.mjs';
import { resolveKeychainBundleAccounts } from './keychain-bundle-accounts.mjs';

/**
 * @param {unknown} err
 */
function isKeychainNotFoundError(err) {
  const anyErr = /** @type {{ stderr?: unknown; message?: unknown }} */ (err ?? {});
  const stderr = typeof anyErr?.stderr === 'string' ? anyErr.stderr : '';
  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(err ?? '');
  const hay = `${stderr}\n${message}`.toLowerCase();
  return (
    hay.includes('the specified item could not be found') ||
    hay.includes('secitemcopymatching') ||
    hay.includes('could not be found in the keychain')
  );
}

/**
 * @param {unknown} err
 */
function isKeychainUnavailableError(err) {
  const anyErr = /** @type {{ code?: unknown; message?: unknown }} */ (err ?? {});
  const code = typeof anyErr?.code === 'string' ? anyErr.code : '';
  if (code === 'ENOENT') return true;

  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(err ?? '');
  return message.toLowerCase().includes('spawnsync security enoent');
}

/**
 * @param {{ service: string; account?: string }} opts
 * @returns {{ bundle: Record<string, string>; found: boolean; unavailable: boolean }}
 */
function readKeychainBundleSafe(opts) {
  try {
    const bundle = readKeychainBundle({ service: opts.service, account: opts.account });
    return { bundle, found: Object.keys(bundle).length > 0, unavailable: false };
  } catch (err) {
    if (isKeychainNotFoundError(err)) {
      return { bundle: {}, found: false, unavailable: false };
    }
    if (isKeychainUnavailableError(err)) {
      return { bundle: {}, found: false, unavailable: true };
    }
    throw err;
  }
}

/**
 * @param {{
 *   baseEnv: Record<string, string>;
 *   secretsSource: 'auto' | 'env' | 'keychain';
 *   keychainService: string;
 *   keychainAccount?: string;
 *   deployEnvironment?: 'production' | 'preview';
 * }} opts
 * @returns {{ env: Record<string, string>; usedKeychain: boolean }}
 */
export function loadSecrets({ baseEnv, secretsSource, keychainService, keychainAccount, deployEnvironment }) {
  if (secretsSource === 'env') {
    return { env: baseEnv, usedKeychain: false };
  }

  if (secretsSource === 'keychain' || secretsSource === 'auto') {
    if (process.platform !== 'darwin') {
      if (secretsSource === 'keychain') {
        throw new Error(
          [
            "[pipeline] secretsSource 'keychain' requires macOS Keychain access (the `security` CLI).",
            '',
            "Use '--secrets-source env' in CI, or run the pipeline locally on macOS.",
          ].join('\n'),
        );
      }
      return { env: baseEnv, usedKeychain: false };
    }

    const { baseAccount, envAccount } = resolveKeychainBundleAccounts({
      accountPrefix: keychainAccount,
      deployEnvironment,
    });

    const legacyAllowed = !String(keychainAccount ?? '').trim();

    const baseRead = readKeychainBundleSafe({ service: keychainService, account: baseAccount });
    const envRead = envAccount
      ? readKeychainBundleSafe({ service: keychainService, account: envAccount })
      : { bundle: {}, found: false, unavailable: false };

    // Optional legacy fallback: a single bundle stored without an account.
    const legacyRead =
      legacyAllowed && !baseRead.found && !envRead.found
        ? readKeychainBundleSafe({ service: keychainService, account: undefined })
        : { bundle: {}, found: false, unavailable: false };

    const keychainUnavailable = baseRead.unavailable || envRead.unavailable || legacyRead.unavailable;
    if (keychainUnavailable) {
      if (secretsSource === 'keychain') {
        throw new Error(
          [
            "[pipeline] secretsSource 'keychain' requires macOS Keychain access (the `security` CLI).",
            '',
            "Use '--secrets-source env' in CI, or run the pipeline locally on macOS.",
          ].join('\n'),
        );
      }
      return { env: baseEnv, usedKeychain: false };
    }

    const foundAny = baseRead.found || envRead.found || legacyRead.found;
    if (!foundAny && secretsSource === 'keychain') {
      throw new Error(
        [
          `[pipeline] Keychain bundle not found for service '${keychainService}'.`,
          '',
          'Run:',
          '  node scripts/pipeline/run.mjs secrets-import --dry-run',
        ].join('\n'),
      );
    }

    const bundle = { ...legacyRead.bundle, ...baseRead.bundle, ...envRead.bundle };

    // Env-file/process env should override Keychain values for fast iteration.
    const merged = { ...bundle, ...baseEnv };
    return { env: merged, usedKeychain: Object.keys(bundle).length > 0 };
  }

  return { env: baseEnv, usedKeychain: false };
}
