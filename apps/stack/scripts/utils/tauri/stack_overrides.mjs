function getTrimmedEnv(env, key) {
  const raw = env?.[key];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

export function applyStackTauriOverrides({ tauriConfig, env }) {
  const identifierOverride = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_IDENTIFIER');
  const productNameOverride = getTrimmedEnv(env, 'HAPPIER_STACK_TAURI_PRODUCT_NAME');

  tauriConfig.identifier = identifierOverride || 'com.happier.stack';
  tauriConfig.productName = productNameOverride || tauriConfig.productName || 'Happier';

  if (tauriConfig.app?.windows?.length) {
    tauriConfig.app.windows = tauriConfig.app.windows.map((w) => ({
      ...w,
      title: tauriConfig.productName ?? w.title,
    }));
  }

  return tauriConfig;
}
