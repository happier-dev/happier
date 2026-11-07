import { CONVERSATION_DELIVERY_CUSTODY_STATES_V1 } from '@happier-dev/channels-protocol/v1';
import type {
  ConversationDeliveryArchiveRecoveryV1,
  ConversationDeliveryResultV1,
  ConversationResolvedEndpointV1,
  ConversationSessionLastDeliveryOutcomeV1,
  CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1,
  CONVERSATION_DELIVERY_RESOLVED_OUTCOMES_V1,
} from '@happier-dev/channels-protocol/v1';

import { conversationRetryDelayMs } from './retryBackoff.js';

export const CONVERSATION_DELIVERY_CUSTODY_STATES = CONVERSATION_DELIVERY_CUSTODY_STATES_V1;

/** Terminal evidence settles replay identity without retaining delivery content. */
export const CONVERSATION_DELIVERY_CONTENT_FREE_STATES = [
  'delivered',
  'notDelivered',
  'suppressed',
  'partial',
  'outcomeUnknown',
  'resolvedAccepted',
  'resolvedDiscarded',
  'connectionDeleted',
  'notSent',
  'resolved',
] as const satisfies readonly ConversationDeliveryCustodyState[];

const CONVERSATION_DELIVERY_RETENTION_ELIGIBLE_STATES = [
  'delivered',
  'notDelivered',
  'suppressed',
  'resolvedAccepted',
  'resolvedDiscarded',
  'connectionDeleted',
  'notSent',
  'resolved',
] as const satisfies readonly ConversationDeliveryCustodyState[];

export type ConversationDeliveryCustodyState =
  (typeof CONVERSATION_DELIVERY_CUSTODY_STATES)[number];

export type ConversationDeliveryCustody = Readonly<{
  state: ConversationDeliveryCustodyState;
  reason?: (typeof CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1)[number];
  outcome?: (typeof CONVERSATION_DELIVERY_RESOLVED_OUTCOMES_V1)[number];
  attemptCount: number;
  attemptId?: string;
  providerMessageIds: readonly string[];
  failedChunk?: number;
  retryNotBefore?: number;
  archiveRecovery?: ConversationDeliveryArchiveRecoveryV1;
  /** A start retains reply-routing work in this same delivery custody. */
  threadBindingPending?: boolean;
  endpoint?: ConversationResolvedEndpointV1;
}>;

type StartResult =
  | Readonly<{ kind: 'started'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notStartable'; reason: 'attemptInProgress' | 'notDue' }>;
type SettleResult =
  | Readonly<{ kind: 'settled'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'staleAttempt' }>;
type ResolveResult =
  | Readonly<{ kind: 'resolved'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notResolvable' }>;
type ConnectionDeletionResult =
  | Readonly<{ kind: 'connectionDeleted'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'retained'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notDeletable'; reason: 'externalEffectMayExist' }>;
type BindingDeletionResult =
  | Readonly<{ kind: 'suppressed'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'retained'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'notDeletable'; reason: 'externalEffectMayExist' }>;

export function createReadyConversationDeliveryCustody(): ConversationDeliveryCustody {
  return { state: 'ready', attemptCount: 0, providerMessageIds: [] };
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
  return {
    kind: 'started',
    custody: {
      state: 'attempting',
      attemptCount: Math.min(Number.MAX_SAFE_INTEGER, input.custody.attemptCount + 1),
      attemptId: input.attemptId,
      providerMessageIds: input.custody.providerMessageIds,
      ...(input.custody.threadBindingPending === undefined ? {} : { threadBindingPending: input.custody.threadBindingPending }),
    },
  };
}
function attemptResultBase(custody: ConversationDeliveryCustody): Pick<
  ConversationDeliveryCustody,
  'attemptCount' | 'threadBindingPending'
> {
  return { attemptCount: custody.attemptCount,
    ...(custody.threadBindingPending === undefined ? {} : { threadBindingPending: custody.threadBindingPending }),
  };
}

export function settleConversationDeliveryAttempt(input: Readonly<{
  custody: ConversationDeliveryCustody;
  attemptId: string;
  result: ConversationDeliveryResultV1;
  now: number;
}>): SettleResult {
  if (input.custody.state !== 'attempting'
    || input.custody.attemptId !== input.attemptId) {
    return { kind: 'staleAttempt' };
  }

  const base = attemptResultBase(input.custody);
  switch (input.result.kind) {
    case 'notReady': {
      // A typed provider refusal precedes submission. The same no-effect
      // transition owns retry/attention; unsupported never becomes ambiguous.
      const permanent = input.result.reason === 'unsupported' || input.result.reason === 'credentialInvalid'
        || input.result.reason === 'permissionMissing' || input.result.reason === 'invalidConfiguration';
      return settleConversationDeliveryAttempt({ ...input, result: {
        kind: 'notDelivered', retry: permanent ? 'never' : input.result.retryAfterMs === undefined ? 'safe' : 'after',
        ...(permanent || input.result.retryAfterMs === undefined ? {} : { retryAfterMs: input.result.retryAfterMs }),
      } });
    }
    case 'delivered':
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: input.custody.threadBindingPending === true && input.result.endpoint === undefined ? 'outcomeUnknown' : 'delivered',
          providerMessageIds: input.result.providerMessageIds,
          ...(input.result.endpoint === undefined ? {} : { endpoint: input.result.endpoint }),
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
      const mayRetry = input.result.retry !== 'never';
      if (mayRetry) {
        const providerWaitMs = input.result.retryAfterMs;
        // A zero wait permits retry but must not turn persistent no-effect
        // failures into a hot loop. Positive provider waits stay authoritative.
        const delayMs = providerWaitMs !== undefined && providerWaitMs > 0
          ? providerWaitMs
          : conversationRetryDelayMs(input.custody.attemptCount);
        return {
          kind: 'settled',
          custody: {
            ...base,
            state: 'retryDue',
            providerMessageIds: [],
            retryNotBefore: Math.min(Number.MAX_SAFE_INTEGER, input.now + delayMs),
          },
        };
      }
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'notSent',
          reason: 'providerRefused',
          providerMessageIds: [],
        },
      };
    }
    case 'endpointArchived':
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'notSent',
          reason: 'ownerMustUnarchiveOrRebind',
          providerMessageIds: [],
        },
      };
    case 'outcomeUnknown':
      return {
        kind: 'settled',
        custody: {
          ...base,
          state: 'outcomeUnknown',
          providerMessageIds: input.result.providerMessageIds ?? [],
          ...(input.result.endpoint === undefined ? {} : { endpoint: input.result.endpoint }),
        },
      };
  }
}

/** Releases a cancelled claim or settles a policy refusal before provider I/O. */
export function settleConversationDeliveryBeforeProviderEffect(input: Readonly<{
  custody: ConversationDeliveryCustody;
  attemptId: string;
  reason: 'cancelled' | 'policySuppressed';
}>): SettleResult {
  if (input.custody.state !== 'attempting' || input.custody.attemptId !== input.attemptId) {
    return { kind: 'staleAttempt' };
  }
  if (input.reason === 'cancelled') {
    const { attemptId: _attemptId, ...custody } = input.custody;
    return { kind: 'settled', custody: { ...custody, state: 'ready' } };
  }
  return {
    kind: 'settled',
    custody: {
      state: 'notSent',
      reason: 'policySuppressed',
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
    || custody.state === 'connectionDeleted'
    || custody.state === 'notSent'
    || custody.state === 'resolved';
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
    // Retained wire field: scheduling does not require owner intervention.
    retryDue: false,
    notDelivered: custody.state === 'notDelivered'
      || (custody.state === 'notSent' && (custody.reason === 'providerRefused' || custody.reason === 'ownerMustUnarchiveOrRebind')),
    partial: custody.state === 'partial',
    outcomeUnknown: custody.state === 'outcomeUnknown',
  };
}

/** Presentation of retained custody only; accepting ambiguous evidence does not prove delivery. */
export function deriveConversationDeliveryLastOutcome(
  custody: ConversationDeliveryCustody,
): ConversationSessionLastDeliveryOutcomeV1 {
  switch (custody.state) {
    case 'ready':
    case 'retryDue':
    case 'attempting':
      return 'pending';
    case 'delivered':
      return 'delivered';
    case 'notDelivered':
    case 'suppressed':
    case 'connectionDeleted':
    case 'notSent':
      return 'notDelivered';
    case 'partial':
    case 'outcomeUnknown':
    case 'resolvedAccepted':
    case 'resolvedDiscarded':
    case 'resolved':
      return 'unknown';
  }
}

export function deriveConversationDeliveryProjection(custody: ConversationDeliveryCustody): Readonly<{
  terminal: boolean;
  attention: boolean;
  retryNotBefore?: number;
}> {
  const attention = deriveConversationDeliveryAttention(custody);
  return {
    terminal: isConversationDeliveryAutomaticTerminal(custody) && !hasPendingConversationThreadBinding(custody),
    attention: attention.notDelivered || attention.partial || attention.outcomeUnknown,
    ...(custody.state === 'retryDue' && custody.retryNotBefore !== undefined
      ? { retryNotBefore: custody.retryNotBefore }
      : {}),
  };
}

export function isConversationDeliveryRetentionEligible(custody: ConversationDeliveryCustody): boolean {
  return !hasPendingConversationThreadBinding(custody)
    && (CONVERSATION_DELIVERY_RETENTION_ELIGIBLE_STATES as readonly string[]).includes(custody.state);
}

/** Successful external delivery must finish ordinary reply routing before retirement. */
export function hasPendingConversationThreadBinding(custody: ConversationDeliveryCustody): boolean {
  return custody.threadBindingPending === true
    && (custody.state === 'delivered' || custody.state === 'resolvedAccepted'
      || (custody.state === 'resolved' && custody.outcome === 'accepted'));
}

/**
 * Terminal custody never resends its body. Unresolved ambiguous rows retain
 * effect evidence for owner resolution while their unused content is dropped.
 */
export function isConversationDeliveryContentFree(custody: ConversationDeliveryCustody): boolean {
  return (CONVERSATION_DELIVERY_CONTENT_FREE_STATES as readonly string[]).includes(custody.state);
}

/**
 * Deletion settles proven no-effect work and retains finished effect evidence.
 * Finished starts lose only their uncompleted reply-binding intent; ambiguous
 * effects remain with recovery. Replaying the finalizer preserves custody.
 */
export function settleConversationDeliveryForConnectionDeletion(input: Readonly<{
  custody: ConversationDeliveryCustody;
}>): ConnectionDeletionResult {
  if (input.custody.state === 'connectionDeleted'
    || (input.custody.state === 'notSent' && input.custody.reason === 'connectionDeleted')) {
    return { kind: 'connectionDeleted', custody: input.custody };
  }
  if (input.custody.state === 'delivered' || input.custody.state === 'resolvedAccepted'
    || input.custody.state === 'resolvedDiscarded' || input.custody.state === 'resolved') {
    return retainConversationDeliveryForRouteDeletion(input.custody);
  }
  if (input.custody.state !== 'ready'
    && input.custody.state !== 'retryDue'
    && input.custody.state !== 'notDelivered'
    && input.custody.state !== 'suppressed'
    && input.custody.state !== 'notSent') {
    return { kind: 'notDeletable', reason: 'externalEffectMayExist' };
  }
  return {
    kind: 'connectionDeleted',
    custody: {
      state: 'notSent',
      reason: 'connectionDeleted',
      attemptCount: input.custody.attemptCount,
      providerMessageIds: [],
    },
  };
}

function retainConversationDeliveryForRouteDeletion(custody: ConversationDeliveryCustody): Readonly<{
  kind: 'retained'; custody: ConversationDeliveryCustody;
}> {
  return { kind: 'retained', custody: hasPendingConversationThreadBinding(custody)
    ? { ...custody, threadBindingPending: false } : custody };
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
        state: 'notSent',
        reason: 'policySuppressed',
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
    || input.custody.state === 'connectionDeleted'
    || input.custody.state === 'notSent'
    || input.custody.state === 'resolved') {
    return retainConversationDeliveryForRouteDeletion(input.custody);
  }
  return { kind: 'notDeletable', reason: 'externalEffectMayExist' };
}

export function resolveConversationDeliveryCustody(input: Readonly<{
  custody: ConversationDeliveryCustody;
  resolution: 'accepted' | 'discarded';
  endpoint?: ConversationResolvedEndpointV1;
}>): ResolveResult {
  if (input.custody.state !== 'partial' && input.custody.state !== 'outcomeUnknown') {
    return { kind: 'notResolvable' };
  }
  return {
    kind: 'resolved',
    custody: {
      state: 'resolved',
      outcome: input.resolution,
      attemptCount: input.custody.attemptCount,
      providerMessageIds: input.custody.providerMessageIds,
      ...(input.custody.threadBindingPending === undefined ? {} : {
        threadBindingPending: input.resolution === 'accepted' && input.custody.threadBindingPending,
      }),
      ...((input.endpoint ?? input.custody.endpoint) === undefined ? {} : { endpoint: input.endpoint ?? input.custody.endpoint }),
      ...(input.custody.failedChunk === undefined ? {} : { failedChunk: input.custody.failedChunk }),
    },
  };
}
