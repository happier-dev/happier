import type {
  ConversationDeliveryArchiveRecoveryV1,
  ConversationDeliveryResultV1,
} from '@happier-dev/channels-protocol/v1';
import { MAX_CONVERSATION_DELIVERY_ATTEMPTS } from '@happier-dev/channels-protocol/v1';

import { conversationRetryDelayMs } from './retryBackoff.js';

export const CONVERSATION_DELIVERY_CUSTODY_STATES = [
  'ready',
  'retryDue',
  'attempting',
  'delivered',
  'notDelivered',
  'suppressed',
  'partial',
  'outcomeUnknown',
  'resolvedAccepted',
  'resolvedDiscarded',
  'connectionDeleted',
] as const;

export type ConversationDeliveryCustodyState =
  (typeof CONVERSATION_DELIVERY_CUSTODY_STATES)[number];

export type ConversationDeliveryCustody = Readonly<{
  state: ConversationDeliveryCustodyState;
  attemptCount: number;
  attemptId?: string;
  startedAt?: number;
  providerMessageIds: readonly string[];
  failedChunk?: number;
  retryNotBefore?: number;
  archiveRecovery?: ConversationDeliveryArchiveRecoveryV1;
}>;

type StartResult =
  | Readonly<{ kind: 'started'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notStartable'; reason: 'attemptInProgress' | 'notDue' | 'attemptLimitReached' }>;
type StaleAttemptRecoveryClaimResult =
  | Readonly<{ kind: 'reclaimed'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notRecoverable'; reason: 'notAttempting' | 'attemptStillCurrent' }>;
type SettleResult =
  | Readonly<{ kind: 'settled'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'staleAttempt' }>;
type ResolveResult =
  | Readonly<{ kind: 'resolved'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notResolvable' }>;
type ArchiveRetryResult =
  | Readonly<{ kind: 'retryReady'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notRetryable' }>;
type ConnectionDeletionResult =
  | Readonly<{ kind: 'connectionDeleted'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notDeletable'; reason: 'externalEffectMayExist' }>;
type BindingDeletionResult =
  | Readonly<{ kind: 'suppressed'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'retained'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notDeletable'; reason: 'externalEffectMayExist' }>;

export function createReadyConversationDeliveryCustody(): ConversationDeliveryCustody {
  return { state: 'ready', attemptCount: 0, providerMessageIds: [] };
}

/**
 * A local validation can prove that no provider effect is possible before an
 * attempt begins. It may terminalize only custody that remains unattempted or
 * retryable, never a claimed provider attempt.
 */
export function settleConversationDeliveryKnownNoEffectBeforeProvider(
  custody: ConversationDeliveryCustody,
): ConversationDeliveryCustody | null {
  if (custody.state !== 'ready' && custody.state !== 'retryDue') return null;
  return {
    state: 'notDelivered',
    attemptCount: custody.attemptCount,
    providerMessageIds: [],
  };
}

export function startConversationDeliveryAttempt(input: Readonly<{
  custody: ConversationDeliveryCustody;
  attemptId: string;
  startedAt: number;
}>): StartResult {
  if (input.custody.state === 'attempting') {
    return { kind: 'notStartable', reason: 'attemptInProgress' };
  }
  if (input.custody.state !== 'ready' && input.custody.state !== 'retryDue') {
    return { kind: 'notStartable', reason: 'notDue' };
  }
  if (input.custody.state === 'retryDue'
    && input.custody.retryNotBefore !== undefined
    && input.startedAt < input.custody.retryNotBefore) {
    return { kind: 'notStartable', reason: 'notDue' };
  }
  if (input.custody.attemptCount >= MAX_CONVERSATION_DELIVERY_ATTEMPTS) {
    return { kind: 'notStartable', reason: 'attemptLimitReached' };
  }
  return {
    kind: 'started',
    custody: {
      state: 'attempting',
      attemptCount: input.custody.attemptCount + 1,
      attemptId: input.attemptId,
      startedAt: input.startedAt,
      providerMessageIds: input.custody.providerMessageIds,
    },
  };
}

/**
 * A crashed/timed-out provider attempt is never resent. Its recovery owner first
 * replaces the persisted attempt identity under CAS, so a late old callback and
 * a concurrent restarted supervisor are both fenced before optional provider
 * reconciliation observes the delivery key.
 */
export function claimStaleConversationDeliveryAttemptRecovery(input: Readonly<{
  custody: ConversationDeliveryCustody;
  recoveryAttemptId: string;
  recoveredAt: number;
  staleAfterMs: number;
}>): StaleAttemptRecoveryClaimResult {
  if (input.custody.state !== 'attempting'
    || input.custody.startedAt === undefined
    || !Number.isSafeInteger(input.custody.startedAt)) {
    return { kind: 'notRecoverable', reason: 'notAttempting' };
  }
  if (!Number.isSafeInteger(input.recoveredAt)
    || !Number.isSafeInteger(input.staleAfterMs)
    || input.staleAfterMs < 0
    || input.recoveredAt < input.custody.startedAt + input.staleAfterMs) {
    return { kind: 'notRecoverable', reason: 'attemptStillCurrent' };
  }
  return {
    kind: 'reclaimed',
    custody: {
      state: 'attempting',
      attemptCount: input.custody.attemptCount,
      attemptId: input.recoveryAttemptId,
      startedAt: input.recoveredAt,
      providerMessageIds: input.custody.providerMessageIds,
    },
  };
}

function attemptResultBase(custody: ConversationDeliveryCustody): Pick<
  ConversationDeliveryCustody,
  'attemptCount'
> {
  return { attemptCount: custody.attemptCount };
}

export function settleConversationDeliveryAttempt(input: Readonly<{
  custody: ConversationDeliveryCustody;
  attemptId: string;
  result: ConversationDeliveryResultV1;
  now: number;
}>): SettleResult {
  if (input.custody.state !== 'attempting' || input.custody.attemptId !== input.attemptId) {
    return { kind: 'staleAttempt' };
  }

  const base = attemptResultBase(input.custody);
  switch (input.result.kind) {
    case 'delivered':
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'delivered',
          providerMessageIds: input.result.providerMessageIds,
        },
      };
    case 'partial':
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'partial',
          providerMessageIds: input.result.providerMessageIds,
          failedChunk: input.result.failedChunk,
        },
      };
    case 'notDelivered': {
      const mayRetry = input.result.retry !== 'never'
        && input.custody.attemptCount < MAX_CONVERSATION_DELIVERY_ATTEMPTS;
      if (mayRetry) {
        return {
          kind: 'settled',
          custody: {
            ...base,
            state: 'retryDue',
            providerMessageIds: [],
            retryNotBefore: input.now + (input.result.retryAfterMs
              ?? conversationRetryDelayMs(input.custody.attemptCount)),
          },
        };
      }
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'notDelivered',
          providerMessageIds: [],
        },
      };
    }
    case 'endpointArchived':
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'notDelivered',
          providerMessageIds: [],
          archiveRecovery: input.result.recovery,
        },
      };
    case 'outcomeUnknown':
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'outcomeUnknown',
          providerMessageIds: input.result.providerMessageIds ?? [],
        },
      };
  }
}

/** Settles a claimed attempt that was proven currentness-ineligible before provider I/O. */
export function suppressConversationDeliveryAttempt(input: Readonly<{
  custody: ConversationDeliveryCustody;
  attemptId: string;
}>): SettleResult {
  if (input.custody.state !== 'attempting' || input.custody.attemptId !== input.attemptId) {
    return { kind: 'staleAttempt' };
  }
  return {
    kind: 'settled',
    custody: {
      state: 'suppressed',
      attemptCount: input.custody.attemptCount,
      providerMessageIds: [],
    },
  };
}

export function isConversationDeliveryAutomaticTerminal(custody: ConversationDeliveryCustody): boolean {
  return custody.state === 'delivered'
    || custody.state === 'notDelivered'
    || custody.state === 'suppressed'
    || custody.state === 'partial'
    || custody.state === 'outcomeUnknown'
    || custody.state === 'resolvedAccepted'
    || custody.state === 'resolvedDiscarded'
    || custody.state === 'connectionDeleted';
}

/**
 * The sole custody-to-status projection. Consumers may summarize these facts,
 * but must not derive an independent delivery-health state or persist one.
 */
export type ConversationDeliveryAttention = Readonly<{
  retryDue: boolean;
  notDelivered: boolean;
  partial: boolean;
  outcomeUnknown: boolean;
}>;

export function deriveConversationDeliveryAttention(
  custody: ConversationDeliveryCustody,
): ConversationDeliveryAttention {
  return {
    retryDue: custody.state === 'retryDue',
    notDelivered: custody.state === 'notDelivered',
    partial: custody.state === 'partial',
    outcomeUnknown: custody.state === 'outcomeUnknown',
  };
}

export function deriveConversationDeliveryProjection(custody: ConversationDeliveryCustody): Readonly<{
  terminal: boolean;
  attention: boolean;
  retryNotBefore?: number;
}> {
  const attention = deriveConversationDeliveryAttention(custody);
  return {
    terminal: isConversationDeliveryAutomaticTerminal(custody),
    attention: attention.notDelivered || attention.partial || attention.outcomeUnknown,
    ...(custody.state === 'retryDue' && custody.retryNotBefore !== undefined
      ? { retryNotBefore: custody.retryNotBefore }
      : {}),
  };
}

export function isConversationDeliveryRetentionEligible(custody: ConversationDeliveryCustody): boolean {
  return custody.state === 'delivered'
    || custody.state === 'notDelivered'
    || custody.state === 'suppressed'
    || custody.state === 'resolvedAccepted'
    || custody.state === 'resolvedDiscarded'
    || custody.state === 'connectionDeleted';
}

/**
 * Deletion can settle only work with no external effect or effect ambiguity.
 * Replaying an already-settled finalizer preserves the same durable custody.
 */
export function settleConversationDeliveryForConnectionDeletion(input: Readonly<{
  custody: ConversationDeliveryCustody;
}>): ConnectionDeletionResult {
  if (input.custody.state === 'connectionDeleted') {
    return { kind: 'connectionDeleted', custody: input.custody };
  }
  if (input.custody.state !== 'ready'
    && input.custody.state !== 'retryDue'
    && input.custody.state !== 'notDelivered'
    && input.custody.state !== 'suppressed') {
    return { kind: 'notDeletable', reason: 'externalEffectMayExist' };
  }
  return {
    kind: 'connectionDeleted',
    custody: {
      state: 'connectionDeleted',
      attemptCount: input.custody.attemptCount,
      providerMessageIds: [],
    },
  };
}

/**
 * A binding delete removes only future route authority. It suppresses custody
 * proven not to have reached a provider and otherwise retains existing
 * terminal evidence; ambiguous provider effects remain with recovery.
 */
export function settleConversationDeliveryForBindingDeletion(input: Readonly<{
  custody: ConversationDeliveryCustody;
}>): BindingDeletionResult {
  if (input.custody.state === 'ready' || input.custody.state === 'retryDue') {
    return {
      kind: 'suppressed',
      custody: {
        state: 'suppressed',
        attemptCount: input.custody.attemptCount,
        providerMessageIds: [],
      },
    };
  }
  if (input.custody.state === 'delivered'
    || input.custody.state === 'notDelivered'
    || input.custody.state === 'suppressed'
    || input.custody.state === 'resolvedAccepted'
    || input.custody.state === 'resolvedDiscarded'
    || input.custody.state === 'connectionDeleted') {
    return { kind: 'retained', custody: input.custody };
  }
  return { kind: 'notDeletable', reason: 'externalEffectMayExist' };
}

export function resolveConversationDeliveryCustody(input: Readonly<{
  custody: ConversationDeliveryCustody;
  resolution: 'accepted' | 'discarded';
}>): ResolveResult {
  if (input.custody.state !== 'partial' && input.custody.state !== 'outcomeUnknown') {
    return { kind: 'notResolvable' };
  }
  return {
    kind: 'resolved',
    custody: {
      state: input.resolution === 'accepted' ? 'resolvedAccepted' : 'resolvedDiscarded',
      attemptCount: input.custody.attemptCount,
      providerMessageIds: input.custody.providerMessageIds,
      ...(input.custody.failedChunk === undefined ? {} : { failedChunk: input.custody.failedChunk }),
    },
  };
}

/**
 * An archive-specific provider result is authoritatively known to have had no
 * effect. Only the recovery arm that permits an owner-led unarchive may reset
 * the existing obligation; generic refusal and ambiguous/partial effects do
 * not gain a blind retry path.
 */
export function retryConversationDeliveryAfterArchiveRecovery(input: Readonly<{
  custody: ConversationDeliveryCustody;
}>): ArchiveRetryResult {
  if (input.custody.state !== 'notDelivered'
    || input.custody.archiveRecovery !== 'unarchiveAndRetry') {
    return { kind: 'notRetryable' };
  }
  return {
    kind: 'retryReady',
    custody: createReadyConversationDeliveryCustody(),
  };
}
