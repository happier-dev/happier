// @ts-check

/**
 * We store pipeline secrets in Keychain as JSON bundles.
 *
 * Convention:
 * - base bundle account: "<prefix>/base" (or "base" if no prefix)
 * - env bundle account:  "<prefix>/<env>" (or "<env>" if no prefix)
 *
 * @param {{ accountPrefix?: string; deployEnvironment?: 'production' | 'preview' }} opts
 */
export function resolveKeychainBundleAccounts(opts) {
  const prefixRaw = String(opts?.accountPrefix ?? '').trim();
  const prefix = prefixRaw ? prefixRaw.replace(/\/+$/, '') : '';

  const baseAccount = prefix ? `${prefix}/base` : 'base';
  const env = opts?.deployEnvironment;
  const envAccount = env ? (prefix ? `${prefix}/${env}` : env) : '';
  return { baseAccount, envAccount };
}

