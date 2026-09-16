import type { TerminalHostHandle } from '@happier-dev/agents';

export function createTmuxTerminalHostHandle(params: Readonly<{
  attachmentId?: NonNullable<TerminalHostHandle['attachmentId']>;
  sessionName: string;
  windowId: string;
  tmuxTmpDir?: string;
  topology: 'shared' | 'exclusive';
}>): TerminalHostHandle {
  const sessionName = params.sessionName.trim();
  const windowId = params.windowId.trim();
  const socketDir = params.tmuxTmpDir?.trim() ?? '';
  if (!sessionName) throw new Error('Tmux terminal host requires a session name');
  if (!/^@\d+$/.test(windowId)) throw new Error('Tmux terminal host requires an immutable window id');
  return {
    ...(params.attachmentId ? { attachmentId: params.attachmentId } : {}),
    kind: 'tmux',
    sessionName,
    paneId: windowId,
    ...(socketDir ? { socketDir } : {}),
    attachMetadata: {
      attachStrategy: 'terminal_host',
      topology: params.topology,
      locality: 'same_machine',
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required',
    },
  };
}
