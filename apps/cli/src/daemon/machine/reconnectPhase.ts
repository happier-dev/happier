import { logger } from '@/ui/logger';

/** Reconnect diagnostics contain phase facts only, never operation data or errors. */
export async function runMachineReconnectPhase<T>(
  phase: 'automation-catch-up' | 'transfer-publication' | 'orphan-settlement'
    | 'endpoint-publication' | 'metadata-publication' | 'pending-recovery',
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  logger.infoFile('[DAEMON RUN] Machine reconnect phase', { phase, status: 'entered', durationMs: 0 });
  let status: 'completed' | 'failed' = 'failed';
  try {
    const result = await operation();
    status = 'completed';
    return result;
  } finally {
    logger.infoFile('[DAEMON RUN] Machine reconnect phase', { phase, status, durationMs: performance.now() - startedAt });
  }
}
