import {
  normalizeCodexBackendMode,
  type CodexBackendMode,
} from '../../protocol/runtimeDescriptorV1.js';

import { resolveCodexBackendModeForRun } from './backendMode.js';

function resolveCodexSettingsBackendMode(settings: Readonly<Record<string, unknown>>): CodexBackendMode {
  return resolveCodexBackendModeForRun({
    codexBackendMode: settings.codexBackendMode,
    defaultBackendMode: settings.experimentalCodexAcp === true ? 'acp' : 'appServer',
  });
}

export type CodexSessionRuntimePreferences = Readonly<{
  codexBackendMode: CodexBackendMode;
  providerAcceptancePendingMaterialization?: 'commitAtMaterialize';
}>;

function buildCodexSessionRuntimePreferences(
  codexBackendMode: CodexBackendMode,
): CodexSessionRuntimePreferences {
  return {
    codexBackendMode,
    ...(codexBackendMode === 'appServer'
      ? { providerAcceptancePendingMaterialization: 'commitAtMaterialize' as const }
      : {}),
  };
}

export function resolveCodexSessionRuntimePreferences(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  processEnv: NodeJS.ProcessEnv;
  startedBy?: 'terminal' | 'daemon';
}>): CodexSessionRuntimePreferences {
  if (params.startedBy === 'daemon') {
    const daemonSelectedBackendMode = normalizeCodexBackendMode(params.processEnv.HAPPIER_CODEX_BACKEND_MODE);
    if (daemonSelectedBackendMode) {
      return buildCodexSessionRuntimePreferences(daemonSelectedBackendMode);
    }
  }

  return buildCodexSessionRuntimePreferences(resolveCodexSettingsBackendMode(params.settings));
}
