import type { Metadata } from '@/api/types';

import type { TerminalRuntimeFlags } from './terminalRuntimeFlags';

export function buildTerminalMetadataFromRuntimeFlags(
  flags: TerminalRuntimeFlags | null,
): Metadata['terminal'] | undefined {
  if (!flags) return undefined;

  const mode = flags.mode;
  if (mode !== 'plain' && mode !== 'tmux' && mode !== 'windows_terminal' && mode !== 'windows_console') return undefined;

  const terminal: NonNullable<Metadata['terminal']> = {
    mode,
  };

  if (
    flags.requested === 'plain'
    || flags.requested === 'tmux'
    || flags.requested === 'windows_terminal'
    || flags.requested === 'console'
  ) {
    terminal.requested = flags.requested;
  }
  if (typeof flags.fallbackReason === 'string' && flags.fallbackReason.trim().length > 0) {
    terminal.fallbackReason = flags.fallbackReason;
  }
  if (typeof flags.tmuxTarget === 'string' && flags.tmuxTarget.trim().length > 0) {
    terminal.tmux = {
      target: flags.tmuxTarget,
      ...(typeof flags.tmuxTmpDir === 'string' && flags.tmuxTmpDir.trim().length > 0
        ? { tmpDir: flags.tmuxTmpDir }
        : {}),
    };
  }

  if (mode === 'windows_terminal' || mode === 'windows_console') {
    terminal.windows = {
      host: mode === 'windows_terminal' ? 'windows_terminal' : 'console',
      ...(typeof flags.windowId === 'string' && flags.windowId.trim().length > 0
        ? { windowId: flags.windowId }
        : {}),
    };
  }

  return terminal;
}
