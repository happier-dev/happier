export function resolveCodexStartingMode(params: Readonly<{
  explicitStartingMode?: 'local' | 'remote';
  startedBy: 'daemon' | 'cli';
  hasTtyForLocal: boolean;
  localControlEnabled: boolean;
}>): 'local' | 'remote' {
  if (params.startedBy === 'daemon') {
    return 'remote';
  }

  if (params.explicitStartingMode) {
    return params.explicitStartingMode;
  }

  if (params.localControlEnabled && params.hasTtyForLocal) {
    return 'local';
  }

  return 'remote';
}
