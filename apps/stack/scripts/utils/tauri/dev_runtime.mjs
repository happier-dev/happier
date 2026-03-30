import { applyStackTauriOverrides } from './stack_overrides.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeTauriConfig(baseValue, overlayValue) {
  if (Array.isArray(overlayValue)) {
    return overlayValue.map((entry) => entry);
  }
  if (!isPlainObject(baseValue) || !isPlainObject(overlayValue)) {
    return overlayValue === undefined ? baseValue : overlayValue;
  }

  const out = { ...baseValue };
  for (const [key, value] of Object.entries(overlayValue)) {
    out[key] = mergeTauriConfig(baseValue[key], value);
  }
  return out;
}

export function resolveStackTauriDevUrl({ runtimeState, defaultPort = 8081 } = {}) {
  const expo = runtimeState && typeof runtimeState === 'object' ? runtimeState.expo : null;
  const port = Number(expo?.webPort ?? expo?.port ?? defaultPort);
  return `http://localhost:${Number.isFinite(port) && port > 0 ? Math.floor(port) : defaultPort}`;
}

export function buildStackTauriDevConfig({ baseConfig, overlayConfig, devUrl, env = process.env } = {}) {
  const merged = mergeTauriConfig(baseConfig ?? {}, overlayConfig ?? {});
  merged.build = {
    ...(merged.build ?? {}),
    devUrl: String(devUrl ?? '').trim() || 'http://localhost:8081',
    beforeDevCommand: '',
    beforeBuildCommand: '',
  };
  const hasExplicitStackOverride =
    String(env?.HAPPIER_STACK_TAURI_IDENTIFIER ?? '').trim() !== ''
    || String(env?.HAPPIER_STACK_TAURI_PRODUCT_NAME ?? '').trim() !== ''
    || String(env?.HAPPIER_STACK_TAURI_CREATE_UPDATER_ARTIFACTS ?? '').trim() !== ''
    || String(env?.TAURI_SIGNING_PRIVATE_KEY ?? '').trim() !== '';
  if (hasExplicitStackOverride) {
    applyStackTauriOverrides({ tauriConfig: merged, env });
  }
  return merged;
}
