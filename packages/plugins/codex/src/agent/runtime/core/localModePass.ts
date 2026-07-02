import type { TerminalRuntimeRunResultV1 } from '@happier-dev/agents';

type QueueModeWithLocalId = { localId?: string | null };

export type CodexLocalModeQueue<Mode extends QueueModeWithLocalId> = Readonly<{
  size: () => number;
}>;

export type CodexLocalModeSession = Readonly<{
  listPendingMessageQueueV2LocalIds: () => Promise<readonly string[]>;
  discardPendingMessageQueueV2All: (options: Readonly<{ reason: 'switch_to_local' }>) => Promise<unknown>;
  discardCommittedMessageLocalIds: (options: Readonly<{
    localIds: readonly string[];
    reason: 'switch_to_local';
  }>) => Promise<unknown>;
  sendSessionEvent: (event: Readonly<{ type: 'message'; message: string }>) => void;
}>;

export type CodexLocalModeTerminalLaunchResult = TerminalRuntimeRunResultV1;

export type CodexLocalModePassResult =
  | { type: 'remote'; resumeId: string | null }
  | { type: 'exit' };

export type CodexLocalModeDiscardController<Mode extends QueueModeWithLocalId> = (args: Readonly<{
  queue: CodexLocalModeQueue<Mode>;
  getServerPendingCount: () => Promise<number>;
  discardServerPending: () => Promise<unknown>;
  markQueuedAsDiscarded: (localIds: readonly string[]) => Promise<unknown>;
  sendStatusMessage: (message: string) => void;
  formatError: (error: unknown) => string;
  onCancelled: () => void;
}>) => Promise<'proceed' | 'cancelled' | string>;

export async function runCodexLocalModePass<Mode extends QueueModeWithLocalId>(opts: Readonly<{
  session: CodexLocalModeSession;
  messageQueue: CodexLocalModeQueue<Mode>;
  workspaceDir: string;
  api: unknown;
  permissionMode: string;
  resumeId: string | null;
  codexArgs?: readonly string[];
  formatError: (error: unknown) => string;
  launchLocal: (args: Readonly<{
    path: string;
    api: unknown;
    session: CodexLocalModeSession;
    messageQueue: CodexLocalModeQueue<Mode>;
    permissionMode: string;
    resumeId: string | null;
    codexArgs?: readonly string[];
  }>) => Promise<CodexLocalModeTerminalLaunchResult>;
  discardController: CodexLocalModeDiscardController<Mode>;
}>): Promise<CodexLocalModePassResult> {
  let cachedServerPendingCount: number | null = null;
  const getServerPendingCount = async (): Promise<number> => {
    if (cachedServerPendingCount !== null) return cachedServerPendingCount;
    cachedServerPendingCount = (await opts.session.listPendingMessageQueueV2LocalIds()).length;
    return cachedServerPendingCount;
  };

  if (opts.messageQueue.size() > 0 || (await getServerPendingCount()) > 0) {
    const discardResult = await opts.discardController({
      queue: opts.messageQueue,
      getServerPendingCount,
      discardServerPending: () => opts.session.discardPendingMessageQueueV2All({ reason: 'switch_to_local' }),
      markQueuedAsDiscarded: (localIds) =>
        opts.session.discardCommittedMessageLocalIds({ localIds: [...localIds], reason: 'switch_to_local' }),
      sendStatusMessage: (message) => {
        opts.session.sendSessionEvent({ type: 'message', message });
      },
      formatError: opts.formatError,
      onCancelled: () => {
        opts.session.sendSessionEvent({
          type: 'message',
          message: 'Keeping queued messages; staying in remote mode.',
        });
      },
    });

    if (discardResult !== 'proceed') {
      return { type: 'remote', resumeId: opts.resumeId };
    }
  }

  const localResult = await opts.launchLocal({
    path: opts.workspaceDir,
    api: opts.api,
    session: opts.session,
    messageQueue: opts.messageQueue,
    permissionMode: opts.permissionMode,
    resumeId: opts.resumeId,
    ...(opts.codexArgs && opts.codexArgs.length > 0 ? { codexArgs: opts.codexArgs } : {}),
  });

  if (localResult.type === 'process_exited') {
    return { type: 'exit' };
  }

  return { type: 'remote', resumeId: localResult.providerSessionId ?? null };
}
