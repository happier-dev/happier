import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { logger } from '@/ui/logger';

export type PendingQueueDrain = Readonly<{
  popPendingMessage: () => Promise<boolean>;
  maxPopPerWake?: number;
}>;

export async function drainPendingQueueMessages(params: Readonly<{
  pendingQueue: PendingQueueDrain | null | undefined;
  logPrefix: string;
  beforeDrain?: (() => boolean | Promise<boolean>) | null;
}>): Promise<void> {
  const pendingQueue = params.pendingQueue;
  if (!pendingQueue) return;

  const maxPopPerWake = Math.max(1, pendingQueue.maxPopPerWake ?? 25);
  for (let i = 0; i < maxPopPerWake; i += 1) {
    if ((await (params.beforeDrain?.() ?? true)) !== true) break;

    let didPop = false;
    try {
      didPop = await pendingQueue.popPendingMessage();
    } catch (error) {
      const terminalAuthStatus = readAuthenticationStatus(error);
      if (terminalAuthStatus !== null) {
        logger.debug(`${params.logPrefix} Stopping pending queue drain after terminal auth failure`, {
          status: terminalAuthStatus,
        });
      }
      break;
    }
    if (!didPop) break;
  }
}
