export type CodexRuntimeMode = 'terminal' | 'remote';

export function resolveCodexStartupRuntimeMode(params: Readonly<{
  explicitRuntimeMode?: CodexRuntimeMode;
  startedBy: 'daemon' | 'cli';
  hasTtyForTerminal: boolean;
  terminalRuntimeEnabled: boolean;
}>): CodexRuntimeMode {
  if (params.startedBy === 'daemon') {
    return 'remote';
  }

  if (params.explicitRuntimeMode) {
    return params.explicitRuntimeMode;
  }

  if (params.terminalRuntimeEnabled && params.hasTtyForTerminal) {
    return 'terminal';
  }

  return 'remote';
}
