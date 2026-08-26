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

export function resolveCodexSessionRuntimePreferences(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  environment: Readonly<Record<string, string | undefined>>;
  startOrigin: 'terminal' | 'daemon';
}>): Readonly<{ codexBackendMode: CodexBackendMode }> {
  if (params.startOrigin === 'daemon') {
    const daemonSelectedBackendMode = normalizeCodexBackendMode(params.environment.HAPPIER_CODEX_BACKEND_MODE);
    if (daemonSelectedBackendMode) {
      return { codexBackendMode: daemonSelectedBackendMode };
    }
  }

  return { codexBackendMode: resolveCodexSettingsBackendMode(params.settings) };
}
