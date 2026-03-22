import type { CodexBackendMode } from '@happier-dev/agents';

export function resolveCodexBackendModeForRun(opts: {
  codexBackendMode?: CodexBackendMode;
  experimentalCodexAcp?: boolean;
  experimentalCodexAcpEnabledByDefault: boolean;
}): CodexBackendMode {
  if (opts.codexBackendMode === 'acp' || opts.codexBackendMode === 'mcp' || opts.codexBackendMode === 'appServer') {
    return opts.codexBackendMode;
  }
  if (opts.experimentalCodexAcp === true) return 'acp';
  if (opts.experimentalCodexAcpEnabledByDefault === true) return 'acp';
  return 'appServer';
}
