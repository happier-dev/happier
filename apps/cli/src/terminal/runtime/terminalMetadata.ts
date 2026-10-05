import type { Metadata } from '@/api/types';
import type { TerminalHostHandle } from '@happier-dev/agents';
import type { TerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import type { TerminalRuntimeFlags } from './terminalRuntimeFlags';

function buildTerminalControlServiceability(
  attachmentId: string | undefined,
): NonNullable<Metadata['terminal']>['controlServiceabilityV1'] | undefined {
  const normalized = attachmentId?.trim();
  return normalized
    ? { v: 1, attachmentId: normalized, state: 'servable', observedAt: Date.now() }
    : undefined;
}

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

export function buildActiveTerminalHostHandleFromMetadata(
  terminal: NonNullable<Metadata['terminal']>,
): TerminalHostHandle | null {
  if (terminal.controlServiceabilityV1?.retired === true) return null;
  return buildTerminalHostHandleFromMetadata(terminal);
}

/** Historical placement is a restoration hint, never an active ownership proof. */
export function buildTerminalHostHandleFromMetadata(
  terminal: NonNullable<Metadata['terminal']>,
): TerminalHostHandle | null {
  const attachmentId = terminal.controlServiceabilityV1?.attachmentId?.trim();
  const common = {
    ...(attachmentId ? { attachmentId: attachmentId as NonNullable<TerminalHostHandle['attachmentId']> } : {}),
    attachMetadata: {
      attachStrategy: 'terminal_host' as const,
      topology: 'shared' as const,
      locality: 'same_machine' as const,
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required' as const,
    },
  };
  if (terminal.mode === 'tmux') {
    const handle = buildTerminalHostProbeHandleFromMetadata(terminal);
    return handle ? { ...handle, ...common } : null;
  }
  if (terminal.mode === 'zellij') {
    const sessionName = terminal.zellij?.sessionName?.trim() ?? '';
    const paneId = terminal.zellij?.paneId?.trim() ?? '';
    if (!sessionName || !paneId) return null;
    return {
      kind: 'zellij',
      sessionName,
      paneId,
      ...(terminal.zellij?.socketDirV1?.trim() ? { socketDir: terminal.zellij.socketDirV1.trim() } : {}),
      ...common,
    };
  }
  if (terminal.mode === 'herdr') {
    const sessionName = terminal.herdr?.sessionName?.trim() ?? '';
    const socketPath = terminal.herdr?.socketPath?.trim() ?? '';
    const terminalId = terminal.herdr?.terminalId?.trim() ?? '';
    if (!sessionName || !socketPath || !terminalId) return null;
    return {
      kind: 'herdr',
      sessionName,
      socketPath,
      terminalId,
      ...(terminal.herdr?.paneId?.trim() ? { paneId: terminal.herdr.paneId.trim() } : {}),
      ...common,
    };
  }
  return null;
}

export function resolveExistingTerminalHostLifecycle(
  metadata: Readonly<Pick<Metadata, 'terminal' | 'startedBy'>> | null | undefined,
  attachmentInfo?: TerminalHostAttachmentInfo | null,
): 'owned' | 'borrowed' | null {
  const handle = metadata?.terminal
    ? buildActiveTerminalHostHandleFromMetadata(metadata.terminal)
    : null;
  if (!handle) return null;
  if (
    attachmentInfo && attachmentInfo.version !== 1
    && attachmentInfo.attachmentId === handle.attachmentId
    && attachmentInfo.handle.kind === handle.kind
  ) {
    return attachmentInfo.version === 3 ? 'borrowed' : 'owned';
  }
  // Only Herdr dispatch establishes an inherited current-pane context.
  // An explicit CLI-created tmux/zellij host is owned regardless of launch source.
  return handle.kind === 'herdr' && metadata?.startedBy !== 'daemon' ? 'borrowed' : 'owned';
}

export function buildTerminalMetadataFromHostHandle(
  handle: TerminalHostHandle,
): NonNullable<Metadata['terminal']> {
  const controlServiceabilityV1 = buildTerminalControlServiceability(handle.attachmentId);
  const binding = controlServiceabilityV1 ? { controlServiceabilityV1 } : {};
  if (handle.kind === 'tmux') {
    return {
      ...binding,
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
      ...binding,
      mode: 'windows_console',
      windows: {
        host: 'console',
        ...(handle.paneId ? { windowId: handle.paneId } : {}),
      },
    };
  }

  if (handle.kind === 'herdr') {
    if (!handle.socketPath?.trim() || !handle.terminalId?.trim()) {
      throw new Error('Herdr terminal identity is incomplete');
    }
    return {
      ...binding,
      mode: 'herdr',
      herdr: {
        sessionName: handle.sessionName,
        socketPath: handle.socketPath,
        terminalId: handle.terminalId,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      },
    };
  }

  return {
    ...binding,
    mode: 'zellij',
    zellij: {
      sessionName: handle.sessionName,
      ...(handle.paneId ? { paneId: handle.paneId } : {}),
      ...(handle.socketDir ? { socketDirV1: handle.socketDir } : {}),
    },
  };
}

export function buildTerminalMetadataFromRuntimeFlags(
  flags: TerminalRuntimeFlags | null,
): Metadata['terminal'] | undefined {
  if (!flags) return undefined;

  const mode = flags.mode;
  if (mode !== 'plain' && mode !== 'tmux' && mode !== 'zellij' && mode !== 'herdr' && mode !== 'windows_terminal' && mode !== 'windows_console') return undefined;

  const terminal: NonNullable<Metadata['terminal']> = {
    mode,
  };

  const controlServiceabilityV1 = buildTerminalControlServiceability(flags.attachmentId);
  if (controlServiceabilityV1) terminal.controlServiceabilityV1 = controlServiceabilityV1;

  if (
    flags.requested === 'plain'
    || flags.requested === 'tmux'
    || flags.requested === 'zellij'
    || flags.requested === 'herdr'
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

  if (mode === 'herdr') {
    const sessionName = flags.herdrSessionName?.trim();
    const socketPath = flags.herdrSocketPath?.trim();
    const terminalId = flags.herdrTerminalId?.trim();
    if (sessionName && socketPath && terminalId) {
      terminal.herdr = {
        sessionName,
        socketPath,
        terminalId,
        ...(flags.herdrPaneId?.trim() ? { paneId: flags.herdrPaneId.trim() } : {}),
      };
    }
  }

  if (mode === 'zellij' && flags.zellijSessionName?.trim() && flags.zellijPaneId?.trim()) {
    terminal.zellij = {
      sessionName: flags.zellijSessionName.trim(),
      paneId: flags.zellijPaneId.trim(),
      ...(flags.zellijSocketDir?.trim() ? { socketDirV1: flags.zellijSocketDir.trim() } : {}),
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
