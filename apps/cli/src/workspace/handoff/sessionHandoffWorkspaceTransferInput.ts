import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

export type SessionHandoffWorkspaceTransferInput = Readonly<
  Omit<SessionHandoffWorkspaceTransfer, 'strategy'> & {
    strategy?: SessionHandoffWorkspaceTransfer['strategy'];
  }
>;
