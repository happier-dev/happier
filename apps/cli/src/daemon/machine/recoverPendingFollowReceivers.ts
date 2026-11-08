import { fetchPendingSessionFollowReceivers } from '@/session/transport/http/sessionFollowInactiveObservationsHttp';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

/** Reconnect reads one Account work set; source custody survives any unavailable read or enqueue. */
export async function recoverPendingFollowReceivers(input: Readonly<{
  token: string; machineId: string; installationId: string; signal: AbortSignal;
  reconcileReceiver: (sessionId: string) => Promise<void>;
}>): Promise<void> {
  const pending = await fetchPendingSessionFollowReceivers({ ...input, reason: 'receiver-recovery' });
  if (pending && 'failure' in pending) {
    logger.warn('[DAEMON RUN] Pending Follow receiver discovery unavailable; source custody retained', {
      failure: pending.failure, diagnostic: pending.diagnostic,
    });
  }
  if (!pending?.ok || input.signal.aborted) return;
  await Promise.all(pending.sessionIds.map(async sessionId => {
    if (input.signal.aborted) return;
    await input.reconcileReceiver(sessionId).catch(error => logger.warn('[DAEMON RUN] Follow reconnect work remains pending', {
      sessionId, error: serializeAxiosErrorForLog(error),
    }));
  }));
}
