export function resolveCodexStartingMode(params: Readonly<{
  explicitStartingMode?: 'local' | 'remote';
  startedBy: 'daemon' | 'cli';
  hasTtyForLocal: boolean;
  terminalRuntimeEnabled: boolean;
}>): 'local' | 'remote' {
  if (params.startedBy === 'daemon') {
    return 'remote';
  }

  if (params.explicitStartingMode) {
    return params.explicitStartingMode;
  }

  if (params.terminalRuntimeEnabled && params.hasTtyForLocal) {
    return 'local';
  }

  return 'remote';
}
