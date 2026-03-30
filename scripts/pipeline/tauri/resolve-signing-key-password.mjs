// @ts-check

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveTauriSigningPrivateKeyPassword(env) {
  return String(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? env.MINISIGN_PASSPHRASE ?? '').trim();
}
