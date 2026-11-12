import type { HostEventEnvelopeV1 } from '@happier-dev/protocol/plugins/events/hostV1';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { logger } from '@/ui/logger';

export function publishDaemonHostEvent(event: HostEventEnvelopeV1, isShuttingDown: () => boolean): void {
  if (isShuttingDown()) return;
  const registryLease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
  if (!registryLease) return;
  try {
    registryLease.registry.stableEventsBroker?.publishHostEventEnvelope(event);
  } catch (error) {
    logger.warn('[DAEMON RUN] Host Event projection failed (ignored)', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    void registryLease.release().catch((error) => {
      logger.warn('[DAEMON RUN] Host Event registry release failed (ignored)', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
