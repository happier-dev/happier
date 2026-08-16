import type { TerminalHostHandle } from '@happier-dev/agents';

import { resolveZellijSocketDir } from '@/integrations/zellij';
import { buildTerminalHostProbeHandleFromMetadata } from '@/terminal/runtime/terminalMetadata';

import type { TerminalAttachmentInfo } from './terminalAttachmentInfo';

export function buildLegacyTerminalAttachmentHostHandle(
  attachmentInfo: TerminalAttachmentInfo,
  happyHomeDir: string,
): TerminalHostHandle | null {
  const current = buildTerminalHostProbeHandleFromMetadata(attachmentInfo.terminal);
  if (current) return current;
  if (attachmentInfo.terminal.mode !== 'zellij') return null;

  const terminal = attachmentInfo.terminal as typeof attachmentInfo.terminal & Readonly<{
    zellij?: Readonly<{
      sessionName?: unknown;
      paneId?: unknown;
      socketDirV1?: unknown;
    }>;
  }>;
  const sessionName = typeof terminal.zellij?.sessionName === 'string'
    ? terminal.zellij.sessionName.trim()
    : '';
  if (!sessionName) return null;
  const paneId = typeof terminal.zellij?.paneId === 'string'
    ? terminal.zellij.paneId.trim()
    : '';
  const socketDir = typeof terminal.zellij?.socketDirV1 === 'string'
    ? terminal.zellij.socketDirV1.trim()
    : resolveZellijSocketDir(happyHomeDir);
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
