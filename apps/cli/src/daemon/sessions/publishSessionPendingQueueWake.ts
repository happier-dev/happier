import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

import type { SessionPendingQueueWakeDiagnostic } from './pendingQueueWake';

export function publishSessionPendingQueueWake(params: Readonly<{
  sessionId: string;
  isShutdownRequested: () => boolean;
  logLabel: string;
  requestWake: () => Promise<SessionPendingQueueWakeDiagnostic>;
}>): void {
  if (params.isShutdownRequested()) return;
  void params.requestWake().then((diagnostic) => {
    const context = {
      event: 'pending_queue_wake' as const,
      sessionId: params.sessionId,
      trigger: params.logLabel,
    };
    if (diagnostic.type === 'unavailable') {
      logger.warn('[DAEMON RUN] Pending queue wake unavailable', {
        ...context,
        outcome: 'unavailable',
        reason: diagnostic.reason,
      });
      return;
    }
    logger.infoFile('[DAEMON RUN] Pending queue wake published', {
      ...context,
      outcome: 'published',
    });
  }, (error) => {
    logger.warn('[DAEMON RUN] Pending queue wake failed', {
      event: 'pending_queue_wake',
      sessionId: params.sessionId,
      trigger: params.logLabel,
      outcome: 'error',
    });
    logger.debug(`[DAEMON RUN] ${params.logLabel} pending queue wake failed`, {
      sessionId: params.sessionId,
      error: serializeAxiosErrorForLog(error),
    });
  });
}
