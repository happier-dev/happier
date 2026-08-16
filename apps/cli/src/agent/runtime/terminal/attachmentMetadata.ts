import type { Metadata } from '@/api/types';
import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

export function buildTerminalAttachmentMetadataFromHostHandle(
  handle: TerminalHostHandle,
): NonNullable<Metadata['terminal']> | null {
  const sessionName = handle.sessionName.trim();
  if (!sessionName) return null;

  if (handle.kind === 'zellij') {
    const paneId = typeof handle.paneId === 'string' ? handle.paneId.trim() : '';
    const socketDirV1 = typeof handle.socketDir === 'string' ? handle.socketDir.trim() : '';
    return {
      mode: 'zellij',
      zellij: {
        sessionName,
        ...(paneId ? { paneId } : {}),
        ...(socketDirV1 ? { socketDirV1 } : {}),
      },
    };
  }

  if (handle.kind === 'tmux') {
    const windowName = typeof handle.paneId === 'string' ? handle.paneId.trim() : '';
    const tmpDir = typeof handle.socketDir === 'string' ? handle.socketDir.trim() : '';
    const target = windowName ? `${sessionName}:${windowName}` : sessionName;

    return {
      mode: 'tmux',
      tmux: {
        target,
        ...(tmpDir ? { tmpDir } : {}),
      },
    };
  }

  if (handle.kind === 'windows_console') {
    return {
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
      },
    };
  }

  return null;
}

export function buildTerminalHostHandleFromAttachmentMetadata(
  terminal: NonNullable<Metadata['terminal']>,
): TerminalHostHandle | null {
  if (terminal.mode === 'zellij') {
    const sessionName = typeof terminal.zellij?.sessionName === 'string'
      ? terminal.zellij.sessionName.trim()
      : '';
    if (!sessionName) return null;
    const paneId = typeof terminal.zellij?.paneId === 'string' ? terminal.zellij.paneId.trim() : '';
    const socketDir = typeof terminal.zellij?.socketDirV1 === 'string' ? terminal.zellij.socketDirV1.trim() : '';
    return {
      kind: 'zellij',
      sessionName,
      ...(paneId ? { paneId } : {}),
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

  if (terminal.mode === 'tmux') {
    const target = typeof terminal.tmux?.target === 'string' ? terminal.tmux.target.trim() : '';
    if (!target) return null;
    const separatorIndex = target.lastIndexOf(':');
    const sessionName = separatorIndex >= 0 ? target.slice(0, separatorIndex).trim() : target;
    const paneId = separatorIndex >= 0 ? target.slice(separatorIndex + 1).trim() : '';
    const socketDir = typeof terminal.tmux?.tmpDir === 'string' ? terminal.tmux.tmpDir.trim() : '';
    if (!sessionName) return null;
    return {
      kind: 'tmux',
      sessionName,
      ...(paneId ? { paneId } : {}),
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

  return null;
}
