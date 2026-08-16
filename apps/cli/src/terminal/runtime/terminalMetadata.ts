import type { Metadata } from '@/api/types';
import type { TerminalHostHandle } from '@happier-dev/agents';

import type { TerminalRuntimeFlags } from './terminalRuntimeFlags';

export function buildTerminalHostProbeHandleFromMetadata(
  terminal: NonNullable<Metadata['terminal']>,
): TerminalHostHandle | null {
  if (terminal.mode !== 'tmux') return null;
  const target = typeof terminal.tmux?.target === 'string'
    ? terminal.tmux.target.trim()
    : '';
  const separatorIndex = target.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= target.length - 1) return null;
  const sessionName = target.slice(0, separatorIndex).trim();
  const paneId = target.slice(separatorIndex + 1).trim();
  if (!sessionName || !paneId) return null;
  const socketDir = typeof terminal.tmux?.tmpDir === 'string'
    ? terminal.tmux.tmpDir.trim()
    : '';
  return {
    kind: 'tmux',
    sessionName,
    paneId,
    ...(socketDir ? { socketDir } : {}),
    attachMetadata: {
      attachStrategy: 'terminal_host',
      topology: 'shared',
      locality: 'same_machine',
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required',
    },
  };
}

export function buildTerminalMetadataFromHostHandle(
  handle: TerminalHostHandle,
): NonNullable<Metadata['terminal']> {
  if (handle.kind === 'tmux') {
    return {
      mode: 'tmux',
      tmux: {
        target: handle.paneId
          ? `${handle.sessionName}:${handle.paneId}`
          : handle.sessionName,
        ...(handle.socketDir ? { tmpDir: handle.socketDir } : {}),
      },
    };
  }

  if (handle.kind === 'windows_console') {
    return {
      mode: 'windows_console',
      windows: {
        host: 'console',
        ...(handle.paneId ? { windowId: handle.paneId } : {}),
      },
    };
  }

  return { mode: 'zellij' };
}

export function buildTerminalMetadataFromRuntimeFlags(
  flags: TerminalRuntimeFlags | null,
): Metadata['terminal'] | undefined {
  if (!flags) return undefined;

  const mode = flags.mode;
  if (mode !== 'plain' && mode !== 'tmux' && mode !== 'zellij' && mode !== 'windows_terminal' && mode !== 'windows_console') return undefined;

  const terminal: NonNullable<Metadata['terminal']> = {
    mode,
  };

  const attachmentId = typeof flags.attachmentId === 'string' ? flags.attachmentId.trim() : '';
  if (attachmentId) {
    terminal.controlServiceabilityV1 = {
      v: 1,
      attachmentId,
      state: 'servable',
      observedAt: Date.now(),
    };
  }

  if (
    flags.requested === 'plain'
    || flags.requested === 'tmux'
    || flags.requested === 'zellij'
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
      ...(typeof flags.title === 'string' && flags.title.trim().length > 0
        ? { title: flags.title }
        : {}),
    };
  }

  return terminal;
}
