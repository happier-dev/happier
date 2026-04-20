import type { CodexBackendMode } from '@happier-dev/agents';

export function resolveCodexBackendModeForRun(opts: {
  codexBackendMode?: CodexBackendMode;
  experimentalCodexAcpEnabledByDefault: boolean;
}): CodexBackendMode {
  if (opts.codexBackendMode === 'acp' || opts.codexBackendMode === 'mcp' || opts.codexBackendMode === 'appServer') {
    return opts.codexBackendMode;
  }
  if (opts.experimentalCodexAcpEnabledByDefault === true) return 'acp';
  return 'appServer';
}
