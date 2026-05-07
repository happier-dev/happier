function getTrimmedEnv(env, key) {
  const raw = env?.[key];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

export function normalizeStackTauriSlug(rawValue) {
  const slug = String(rawValue ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || '';
}

export function resolveStackTauriIdentity({ env = {}, baseProductName = 'Happier' } = {}) {
  const stackSlug = normalizeStackTauriSlug(getTrimmedEnv(env, 'HAPPIER_STACK_STACK'));
  const explicitIdentifier = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_IDENTIFIER');
  const explicitProductName = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_PRODUCT_NAME');
  const shouldScope = stackSlug && stackSlug !== 'main';
  return {
    stackSlug,
    identifier: explicitIdentifier || (shouldScope ? `com.happier.stack.${stackSlug}` : 'com.happier.stack'),
    productName: explicitProductName || (shouldScope ? `${baseProductName || 'Happier'} (${stackSlug})` : baseProductName || 'Happier'),
  };
}

export function applyStackTauriOverrides({ tauriConfig, env }) {
  const createUpdaterArtifactsOverride = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_CREATE_UPDATER_ARTIFACTS');
  const signingPrivateKey = getTrimmedEnv(env, 'TAURI_SIGNING_PRIVATE_KEY');
  const identity = resolveStackTauriIdentity({
    env,
    baseProductName: tauriConfig.productName || 'Happier',
  });

  tauriConfig.identifier = identity.identifier;
  tauriConfig.productName = identity.productName;

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
