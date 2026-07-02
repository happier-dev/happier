import { normalizeCodexBackendMode, type CodexBackendMode as CanonicalCodexBackendMode } from '@happier-dev/protocol';

import {
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexProviderSessionId,
} from '../../providers/codex/runtimeIdentity.js';

export type CodexBackendMode = CanonicalCodexBackendMode;

export function resolveCodexRuntimeBackendMode(params: Readonly<{
  codexBackendMode?: unknown;
  defaultBackendMode?: CodexBackendMode | null;
}>): CodexBackendMode | null {
  const explicitMode = normalizeCodexBackendMode(params.codexBackendMode);
  if (explicitMode) return explicitMode;
  const fallback = normalizeCodexBackendMode(params.defaultBackendMode);
  if (fallback) return fallback;
  return null;
}

export function resolveCodexRuntimeBackendModeFromSettings(
  settings: Readonly<Record<string, unknown>>,
  params: Readonly<{
    defaultBackendMode?: CodexBackendMode | null;
  }> = {},
): CodexBackendMode | null {
  const canonicalMode = resolveCodexRuntimeBackendMode({
    codexBackendMode: settings.codexBackendMode,
    defaultBackendMode: params.defaultBackendMode,
  });
  if (canonicalMode) return canonicalMode;
  return settings.experimentalCodexAcp === true ? 'acp' : null;
}

export function resolveCodexSpawnExtrasFromSettings(settings: Readonly<Record<string, unknown>>): Readonly<{
  codexBackendMode?: CodexBackendMode;
}> {
  const mode = resolveCodexRuntimeBackendModeFromSettings(settings);
  if (!mode) return {};
  return { codexBackendMode: mode };
}

export function resolveCodexSessionRuntimePreferences(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  processEnv: NodeJS.ProcessEnv;
}>): Readonly<{
  codexBackendMode?: CodexBackendMode;
}> {
  void params.processEnv;
  const codexBackendMode = resolveCodexRuntimeBackendModeFromSettings(params.settings, {
    defaultBackendMode: 'appServer',
  });
  return codexBackendMode ? { codexBackendMode } : {};
}

function readExplicitCodexBackendModeFromEnv(processEnv: NodeJS.ProcessEnv): CodexBackendMode | null {
  return normalizeCodexBackendMode(processEnv.HAPPIER_CODEX_BACKEND_MODE);
}

export function resolveCodexSpawnExtrasForRuntime(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  processEnv: NodeJS.ProcessEnv;
}>): Readonly<{
  codexBackendMode?: CodexBackendMode;
}> {
  const extras = resolveCodexSpawnExtrasFromSettings(params.settings);
  if (extras.codexBackendMode) {
    return extras;
  }

  const explicitCodexBackendMode = readExplicitCodexBackendModeFromEnv(params.processEnv);
  if (explicitCodexBackendMode) {
    return { codexBackendMode: explicitCodexBackendMode };
  }

  return {};
}

export function isCodexVendorResumeBackendEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  const mode = resolveCodexRuntimeBackendModeFromSettings(settings);
  return mode === 'acp' || mode === 'appServer';
}
