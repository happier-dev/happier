import type { TerminalAttachmentId, TerminalHostHandle } from '@/integrations/terminalHost/_types';

export function createTmuxTerminalHostHandle(params: Readonly<{
  attachmentId?: TerminalAttachmentId;
  sessionName: string;
  windowName?: string;
  tmuxTmpDir?: string;
  topology: 'shared' | 'exclusive';
}>): TerminalHostHandle {
  const sessionName = params.sessionName.trim();
  const paneId = params.windowName?.trim() ?? '';
  const socketDir = params.tmuxTmpDir?.trim() ?? '';
  if (!sessionName) throw new Error('Tmux terminal host requires a session name');
  if (params.topology === 'shared' && !paneId) {
    throw new Error('Shared tmux terminal host requires an owned window name');
  }
  return {
    ...(params.attachmentId ? { attachmentId: params.attachmentId } : {}),
    kind: 'tmux',
    sessionName,
    ...(paneId ? { paneId } : {}),
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
