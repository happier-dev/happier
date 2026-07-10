import type { PendingDeliveryBlockedReason } from './pendingDeliveryBlockedReason.js';
import { normalizePendingDeliveryBlockedReason } from './pendingDeliveryBlockedReason.js';

export type PendingDeliveryStatusV1 =
  | Readonly<{ status: 'queued' }>
  | Readonly<{ status: 'delivering' }>
  | Readonly<{ status: 'blocked'; reason: PendingDeliveryBlockedReason }>
  | Readonly<{ status: 'discarded'; reason: string | null }>;

export type PendingDeliveryResolvedReasonV1 = 'provider_accepted' | 'materialized' | 'manual_handled';

export type PendingDeliveryStatusTransitionTargetV1 =
  | PendingDeliveryStatusV1
  | Readonly<{
      status: 'resolved';
      reason: 'provider_accepted';
      acceptedThroughSeq?: boolean;
    }>
  | Readonly<{
      status: 'resolved';
      reason: Exclude<PendingDeliveryResolvedReasonV1, 'provider_accepted'>;
    }>;

export type PendingDeliveryStatusPersistedFieldsV1 = Readonly<{
  status?: unknown;
  deliveryState?: unknown;
  deliveryBlockedReason?: unknown;
  discardedReason?: unknown;
}>;

export type PendingDeliveryStatusPersistedProjectionV1 = Readonly<{
  status: 'queued' | 'discarded';
  deliveryState: 'delivering' | 'blocked' | null;
  deliveryBlockedReason: PendingDeliveryBlockedReason | null;
  discardedReason: string | null;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizePendingDeliveryStatusV1(fields: PendingDeliveryStatusPersistedFieldsV1): PendingDeliveryStatusV1 {
  if (fields.status === 'discarded') {
    return { status: 'discarded', reason: readNonEmptyString(fields.discardedReason) };
  }

  if (fields.status !== 'queued') {
    return { status: 'queued' };
  }

  if (fields.deliveryState === 'delivering') {
    return { status: 'delivering' };
  }

  if (fields.deliveryState === 'blocked') {
    return {
      status: 'blocked',
      reason: normalizePendingDeliveryBlockedReason(fields.deliveryBlockedReason) ?? 'unknown',
    };
  }

  return { status: 'queued' };
}

export function parsePendingDeliveryStatusV1(value: unknown): PendingDeliveryStatusV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status === 'queued') {
    return { status: 'queued' };
  }
  if (record.status === 'delivering') {
    return { status: 'delivering' };
  }
  if (record.status === 'blocked') {
    return {
      status: 'blocked',
      reason: normalizePendingDeliveryBlockedReason(record.reason) ?? 'unknown',
    };
  }
  if (record.status === 'discarded') {
    return { status: 'discarded', reason: readNonEmptyString(record.reason) };
  }
  return null;
}

export function pendingDeliveryStatusV1ToPersistedFields(
  status: PendingDeliveryStatusV1,
): PendingDeliveryStatusPersistedProjectionV1 {
  switch (status.status) {
    case 'queued':
      return { status: 'queued', deliveryState: null, deliveryBlockedReason: null, discardedReason: null };
    case 'delivering':
      return { status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null, discardedReason: null };
    case 'blocked':
      return {
        status: 'queued',
        deliveryState: 'blocked',
        deliveryBlockedReason: status.reason,
        discardedReason: null,
      };
    case 'discarded':
      return { status: 'discarded', deliveryState: null, deliveryBlockedReason: null, discardedReason: status.reason };
  }
}

export function isPendingDeliveryStatusTransitionAllowedV1(
  from: PendingDeliveryStatusV1,
  to: PendingDeliveryStatusTransitionTargetV1,
): boolean {
  if (to.status === 'resolved') {
    if (to.reason === 'provider_accepted') {
      return to.acceptedThroughSeq === true
        ? from.status === 'delivering' || from.status === 'blocked'
        : from.status === 'delivering' || from.status === 'blocked';
    }
    if (to.reason === 'manual_handled') {
      return from.status === 'delivering' || from.status === 'blocked';
    }
    return from.status === 'queued';
  }

  if (from.status === to.status) {
    return true;
  }

  if (from.status === 'queued') {
    return to.status === 'delivering' || to.status === 'blocked' || to.status === 'discarded';
  }

  if (from.status === 'delivering') {
    return to.status === 'blocked' || to.status === 'discarded';
  }

  if (from.status === 'blocked') {
    return to.status === 'queued' || to.status === 'discarded';
  }

  return to.status === 'queued';
}
