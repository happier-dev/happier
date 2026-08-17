import type { PendingDeliveryBlockedReason } from './pendingDeliveryBlockedReason.js';
import { normalizePendingDeliveryBlockedReason } from './pendingDeliveryBlockedReason.js';

export type PendingDeliveryDetailV1 = 'custody_observed' | 'awaiting_acceptance';

export type PendingDeliveryStatusV1 =
  | Readonly<{ status: 'queued' }>
  | Readonly<{ status: 'delivering'; detail?: PendingDeliveryDetailV1 }>
  | Readonly<{ status: 'external_handoff' }>
  | Readonly<{ status: 'blocked'; reason: PendingDeliveryBlockedReason }>
  | Readonly<{ status: 'discarded'; reason: string | null }>;

export type PendingDeliveryResolvedReasonV1 = 'provider_accepted' | 'materialized' | 'manual_handled';
export type PendingDeliveryArchivedUncertaintyReasonV1 = 'dismissed_uncertain' | 'resent_as_new';

export const PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1 = ['resent_as_new'] as const satisfies readonly PendingDeliveryArchivedUncertaintyReasonV1[];
const pendingDeliveryHiddenDiscardedReasonsV1 = new Set<string>(PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1);

export type PendingDeliveryStatusTransitionTargetV1 =
  | PendingDeliveryStatusV1
  | Readonly<{
      status: 'resolved';
      reason: 'provider_accepted';
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
  deliveryState: 'delivering' | 'external_handoff' | 'blocked' | null;
  deliveryBlockedReason: PendingDeliveryBlockedReason | null;
  discardedReason: string | null;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readPendingDeliveryDetailV1(value: unknown): PendingDeliveryDetailV1 | null {
  return value === 'custody_observed' || value === 'awaiting_acceptance' ? value : null;
}

export function normalizePendingDeliveryStatusV1(fields: PendingDeliveryStatusPersistedFieldsV1): PendingDeliveryStatusV1 {
  if (fields.status === 'discarded') {
    return { status: 'discarded', reason: readNonEmptyString(fields.discardedReason) };
  }

  if (fields.status !== 'queued') {
    return { status: 'queued' };
  }

  if (fields.deliveryState === 'delivering') {
    return { status: 'delivering', detail: 'awaiting_acceptance' };
  }
  if (fields.deliveryState === 'external_handoff') {
    return { status: 'external_handoff' };
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
    const detail = readPendingDeliveryDetailV1(record.detail);
    return detail ? { status: 'delivering', detail } : { status: 'delivering' };
  }
  if (record.status === 'external_handoff') {
    return { status: 'external_handoff' };
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
    case 'external_handoff':
      return { status: 'queued', deliveryState: 'external_handoff', deliveryBlockedReason: null, discardedReason: null };
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

export function isPendingDeliveryProviderEffectPossibleV1(status: PendingDeliveryStatusV1): boolean {
  if (status.status === 'delivering' || status.status === 'external_handoff') return true;
  if (status.status !== 'blocked') return false;
  return status.reason === 'ambiguous_terminal_delivery'
    || status.reason === 'delivery_outcome_uncertain'
    || status.reason === 'unknown';
}

export function isPendingDeliveryArchivedUncertaintyReasonV1(
  value: unknown,
): value is PendingDeliveryArchivedUncertaintyReasonV1 {
  return value === 'dismissed_uncertain' || value === 'resent_as_new';
}

export function shouldExposePendingDeliveryInDiscardedHistoryV1(status: PendingDeliveryStatusV1): boolean {
  return status.status === 'discarded'
    && !pendingDeliveryHiddenDiscardedReasonsV1.has(status.reason ?? '');
}

export function isPendingDeliveryStatusTransitionAllowedV1(
  from: PendingDeliveryStatusV1,
  to: PendingDeliveryStatusTransitionTargetV1,
): boolean {
  if (to.status === 'resolved') {
    if (to.reason === 'provider_accepted') {
      return from.status === 'delivering'
        || from.status === 'external_handoff'
        || from.status === 'blocked'
        || (from.status === 'discarded' && isPendingDeliveryArchivedUncertaintyReasonV1(from.reason));
    }
    if (to.reason === 'manual_handled') {
      return from.status === 'delivering' || from.status === 'external_handoff' || from.status === 'blocked';
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
  if (from.status === 'external_handoff') {
    return to.status === 'blocked' || to.status === 'discarded';
  }

  if (from.status === 'blocked') {
    return to.status === 'queued' || to.status === 'discarded';
  }

  if (from.status === 'discarded' && isPendingDeliveryArchivedUncertaintyReasonV1(from.reason)) {
    return false;
  }
  return to.status === 'queued';
}
