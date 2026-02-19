function getTrimmedEnv(env, key) {
  const raw = env?.[key];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

export function applyStackTauriOverrides({ tauriConfig, env }) {
  const identifierOverride = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_IDENTIFIER');
  const productNameOverride = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_PRODUCT_NAME');
  const createUpdaterArtifactsOverride = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_CREATE_UPDATER_ARTIFACTS');
  const signingPrivateKey = getTrimmedEnv(env, 'TAURI_SIGNING_PRIVATE_KEY');

  tauriConfig.identifier = identifierOverride || 'com.happier.stack';
  tauriConfig.productName = productNameOverride || tauriConfig.productName || 'Happier';

  if (tauriConfig.app?.windows?.length) {
    tauriConfig.app.windows = tauriConfig.app.windows.map((w) => ({
      ...w,
      title: tauriConfig.productName ?? w.title,
    }));
  }

  // Tauri's updater artifact bundling requires a signing private key at build time.
  // For local user builds we keep the updater plugin configured (pubkey/endpoints) but skip generating updater artifacts
  // unless signing is explicitly enabled.
  if (tauriConfig.bundle && typeof tauriConfig.bundle === 'object') {
    const shouldCreateUpdaterArtifacts =
      createUpdaterArtifactsOverride !== ''
        ? createUpdaterArtifactsOverride !== '0'
        : signingPrivateKey !== ''
          ? (tauriConfig.bundle.createUpdaterArtifacts ?? true)
          : false;

    tauriConfig.bundle.createUpdaterArtifacts = shouldCreateUpdaterArtifacts;
  }

  return tauriConfig;
}
