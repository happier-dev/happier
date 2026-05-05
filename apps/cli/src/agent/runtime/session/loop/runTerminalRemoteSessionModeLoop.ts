export type TerminalRemoteSessionMode = 'terminal' | 'remote';
export type TerminalRemoteSessionTerminalEntry = 'initial' | 'switch';

export type TerminalRemoteSessionTerminalResult =
  | Readonly<{ type: 'switch' }>
  | Readonly<{ type: 'exit'; code: number }>;

export type TerminalRemoteSessionRemoteResult = 'switch' | 'exit';

export type RunTerminalRemoteSessionModeLoopOptions = Readonly<{
  startingMode?: TerminalRemoteSessionMode | null;
  remoteExitCode: number;
  runTerminal: (params: Readonly<{ entry: TerminalRemoteSessionTerminalEntry }>) => Promise<TerminalRemoteSessionTerminalResult>;
  runRemote: () => Promise<TerminalRemoteSessionRemoteResult>;
  onModeChange: (mode: TerminalRemoteSessionMode) => void | Promise<void>;
  onBeforeIteration?: (mode: TerminalRemoteSessionMode) => void | Promise<void>;
}>;

export async function runTerminalRemoteSessionModeLoop(
  opts: RunTerminalRemoteSessionModeLoopOptions,
): Promise<number> {
  let mode: TerminalRemoteSessionMode = opts.startingMode ?? 'terminal';
  let terminalEntry: TerminalRemoteSessionTerminalEntry = mode === 'terminal' ? 'initial' : 'switch';

  while (true) {
    await opts.onBeforeIteration?.(mode);

    if (mode === 'terminal') {
      const result = await opts.runTerminal({ entry: terminalEntry });
      terminalEntry = 'switch';
      if (result.type === 'exit') {
        return result.code;
      }
      mode = 'remote';
      await opts.onModeChange(mode);
      continue;
    }

    const reason = await opts.runRemote();
    if (reason === 'exit') {
      return opts.remoteExitCode;
    }
    mode = 'terminal';
    terminalEntry = 'switch';
    await opts.onModeChange(mode);
  }
}
