import type { PendingQueueDeliveryBlockedReason } from '@/api/session/pendingQueueV2Transport';
import { logger } from '@/ui/logger';
import { readPendingLocalId } from '@happier-dev/protocol';

export type PendingDeliveryBlocker = (params: Readonly<{
  localIds: readonly string[] | null | undefined;
  reason: PendingQueueDeliveryBlockedReason;
  providerEffect?: 'none';
}>) => Promise<boolean>;

export function normalizePendingDeliveryLocalIds(
  localIds: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of localIds ?? []) {
    const localId = readPendingLocalId(value);
    if (localId === null || seen.has(localId)) continue;
    seen.add(localId);
    normalized.push(localId);
  }
  return normalized;
}

export function readSinglePendingDeliveryLocalId(
  localIds: readonly string[] | null | undefined,
): string | null {
  if (localIds?.length !== 1) return null;
  const localId = localIds[0];
  return readPendingLocalId(localId);
}

export function blockUndeliverableProviderPrompt(params: Readonly<{
  localIds: readonly string[] | null | undefined;
  blockPendingMessageDelivery?: PendingDeliveryBlocker | undefined;
  blockReason: PendingQueueDeliveryBlockedReason;
  logPrefix: string;
}>): void {
  const localId = readSinglePendingDeliveryLocalId(params.localIds);
  if (!localId) {
    logger.debug(`${params.logPrefix}: undeliverable Pending input does not carry one exact localId; refusing local replay`, {
      localIdCount: params.localIds?.length ?? 0,
    });
    return;
  }
  if (!params.blockPendingMessageDelivery) {
    logger.debug(`${params.logPrefix}: exact pending delivery cannot be blocked because the server owner is unavailable; refusing local replay`);
    return;
  }

  void params.blockPendingMessageDelivery({ localIds: [localId], reason: params.blockReason })
    .catch((error) => {
      logger.debug(`${params.logPrefix}: failed to block exact undeliverable pending delivery; refusing local replay`, error);
    });
}
