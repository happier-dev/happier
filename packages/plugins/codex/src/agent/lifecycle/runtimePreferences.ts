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
  processEnv: NodeJS.ProcessEnv;
  startedBy?: 'terminal' | 'daemon';
}>): Readonly<{ codexBackendMode: CodexBackendMode }> {
  if (params.startedBy === 'daemon') {
    const daemonSelectedBackendMode = normalizeCodexBackendMode(params.processEnv.HAPPIER_CODEX_BACKEND_MODE);
    if (daemonSelectedBackendMode) {
      return { codexBackendMode: daemonSelectedBackendMode };
    }
  }

  return { codexBackendMode: resolveCodexSettingsBackendMode(params.settings) };
}
