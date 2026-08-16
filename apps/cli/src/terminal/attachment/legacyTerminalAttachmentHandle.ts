import { buildTerminalHostHandleFromAttachmentMetadata } from '@/agent/runtime/terminal/attachmentMetadata';
import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { resolveZellijSocketDir } from '@/integrations/zellij/socketDir';

import type { LegacyTerminalAttachmentInfo } from './terminalAttachmentInfo';

export function buildLegacyTerminalAttachmentHostHandle(
  attachmentInfo: LegacyTerminalAttachmentInfo,
  happyHomeDir: string,
): TerminalHostHandle | null {
  const handle = buildTerminalHostHandleFromAttachmentMetadata(attachmentInfo.terminal);
  if (!handle || handle.kind !== 'zellij' || handle.socketDir) return handle;

  // Released v1 Zellij writers derived this root deterministically from their
  // owning Happier home but did not persist it.
  return {
    ...handle,
    socketDir: resolveZellijSocketDir(happyHomeDir),
  };
}
