import { compareSessionFollowFrontierProgressV1, isSessionFollowFrontierEqualV1, isSessionFollowTurnEqualV1, SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { deriveSessionFollowWakeEventLocalIdV1, normalizeSessionFollowWakeObservationsV1, type SessionFollowObservePendingRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { isAuthoritativeHumanSessionFollowMessageV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowUpdateEnvelopeV1';
import { isFollowPolicyEqualV1, resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { classifyWorkerUpdateEventV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { buildAgentEventLocalId } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { WorkerUpdateFollowMatchV1 } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { renderSessionInputContextPromptV1, renderWorkerUpdatePromptBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { SessionFollowUpdateEnvelopeV1, WorkerUpdateV1 } from '@happier-dev/protocol';
import type { SessionFollowDiscussionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { logger } from '@/ui/logger';
import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { classifyHomeReadPreparationError } from '@/agent/prompts/library/homeReadPreparationError';
import { renderRunFollowNotice } from './sessionFollowNotice';

export type SessionFollowQueuedDelivery = Readonly<{
  delivery: SessionFollowInputV1;
  localInputId: string;
  userMessageSeq: number | null;
  /** Public-safe route reasons projected from the validated Pending admission receipt. */
  followMatches?: readonly WorkerUpdateFollowMatchV1[];
}>;

import { applySessionFollowContextBudgetV1 } from './sessionFollowContextBudget';
import { measureSessionFollowUtf8Bytes } from './sessionFollowContextBudget';
import { fitWorkerUpdateWithinHostContextAllowance } from '../contextOnly/hostContextOnlyInput';
import type {
  SessionFollowHydratedUpdate,
  SessionFollowHydrationReadModeV1,
  SessionFollowHydrationObservationV1 as SessionFollowPendingObservationV1,
} from './sessionFollowSourceHydrator';
import type { SessionFollowSourceMaterialController } from './sessionFollowSourceMaterialResolver';

export type SessionFollowHydrateObservation = (input: Readonly<{
  observation: SessionFollowPendingObservationV1;
  signal: AbortSignal;
  readMode: SessionFollowHydrationReadModeV1;
  /** Wake discovery: also report whether protected human ingress exists anywhere in the pending range. */
  discoverHumanIngress?: boolean;
  selectionChannel?: 'voice';
}>) => Promise<(SessionFollowUpdateEnvelopeV1 & Partial<Pick<
  SessionFollowHydratedUpdate,
  'sourceRecencyMs' | 'transcriptConsumedThroughByRenderedMessageCount' | 'pendingHumanIngress' | 'workerUpdate' | 'recheckWorkerUpdateAdmission' | 'isOriginalRequestWithdrawn'
>>) | null>;

/** One hydrated-source decision shared by active and absent-host Follow admission. */
export function shouldWakeForSessionFollowObservation(
  observation: SessionFollowPendingObservationV1,
  source: SessionFollowUpdateEnvelopeV1 & Partial<Pick<SessionFollowHydratedUpdate, 'pendingHumanIngress' | 'workerUpdate'>>,
): boolean {
  if (source.reason === 'source_unavailable'
    || !isSessionAwarenessContentReadableV1(source.awareness.encryption)
    || source.edge.sourceSessionId !== observation.sourceSessionId
    || source.edge.destinationSessionId !== observation.destinationSessionId
    || source.awareness.sessionId !== observation.sourceSessionId) return false;
  if ('kind' in observation || observation.relation === 'rule') return observation.effectiveDelivery === 'wake';
  const wakes = (event: Parameters<typeof resolveFollowDeliveryV1>[0]['event']) =>
    resolveFollowDeliveryV1({ policies: [observation.policy], event }).session.wake;
  if ((source.pendingHumanIngress === true || source.recentMessages.some(isAuthoritativeHumanSessionFollowMessageV1))
    && wakes({ kind: 'person_wrote' })) return true;
  if (source.recentMessages.some(message => message.event?.kind === 'goal_changed')
    && wakes({ kind: 'goal_changed' })) return true;
  if (shouldWakeForSessionFollowWorkerUpdate(observation, source)) return true;
  // A message may wake only through an explicit Custom choice. Proven human
  // ingress is classified above, never inferred from a role or missing provenance.
  return source.recentMessages.some(message => !message.event && !isAuthoritativeHumanSessionFollowMessageV1(message))
    && wakes({ kind: 'message' });
}

/** Turn-only intake must select the worker outcome itself, never unrelated transcript ingress. */
export function shouldWakeForSessionFollowWorkerUpdate(
  observation: SessionFollowPendingObservationV1,
  source: SessionFollowUpdateEnvelopeV1 & Partial<Pick<SessionFollowHydratedUpdate, 'workerUpdate'>>,
): boolean {
  if ('kind' in observation || !source.workerUpdate || source.reason === 'source_unavailable'
    || !isSessionAwarenessContentReadableV1(source.awareness.encryption)
    || source.edge.sourceSessionId !== observation.sourceSessionId
    || source.edge.destinationSessionId !== observation.destinationSessionId
    || source.awareness.sessionId !== observation.sourceSessionId) return false;
  const kind = classifyWorkerUpdateEventV1(source.workerUpdate);
  if (observation.relation === 'rule') return kind === 'stalled' && observation.effectiveDelivery === 'wake';
  return kind !== null && resolveFollowDeliveryV1({ policies: [observation.policy], event: kind === 'needs_you'
    ? { kind, type: source.awareness.operational.primary === 'permission_required' ? 'approval'
      : source.awareness.operational.reasons.includes('blocked_input') ? 'blocked' : 'decision' }
    : { kind } }).session.wake;
}

export type SessionFollowPreparedContext = Readonly<{
  representedFollowLocalInputIds?: readonly string[];
  withdrawnFollowLocalInputIds?: readonly string[];
  updates: readonly SessionFollowUpdateEnvelopeV1[];
  workerUpdates?: readonly WorkerUpdateV1[];
  /** Per-worker cards share the incumbent frontier identity owner, independently of batch membership. */
  workerUpdateEvents?: readonly Readonly<{ localId: string; update: WorkerUpdateV1;
    followMatches?: readonly WorkerUpdateFollowMatchV1[]; followInputLocalId?: string }>[];
  /** Present only for a wake; this is the deterministic durable event identity committed before delivery. */
  wakeEventLocalId?: string;
  acknowledgeAccepted: (input: Readonly<{
    kind: 'admitted_input';
    localInputId: string;
    userMessageSeq: number | null;
  }> | Readonly<{
    kind: 'context_only_wake';
    eventLocalId: string;
  }>, pendingSettlement?: Promise<void>) => void;
}>;

/**
 * What the reconciler returns: prepared context that can re-enter the same
 * server admission at a later effect boundary. A context-only wake is prepared
 * before it is queued and before the checkpoint capture, so its dispatch
 * boundary must ask again whether every represented edge is still admitted
 * (09D §6.3 "final access + exact runtime authority recheck").
 */
export type SessionFollowReconciledContext = SessionFollowPreparedContext & Readonly<{
  recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
}>;

type SessionFollowAdmissionObservationEntry = SessionFollowPendingObservationV1 & Readonly<{
  voiceExpected?: SessionFollowPendingObservationV1['delivered'] | null;
  voicePolicySelected?: boolean;
}>;

type SessionFollowAdmissionObservation = Readonly<{
  ok: boolean;
  publisherGeneration?: string;
  executionRunOccurrenceId?: string;
  currentSourceSessionIds?: readonly string[];
  observations?: readonly SessionFollowAdmissionObservationEntry[];
  wakeAdmission?: Readonly<{ status: 'allowed' } | { status: 'held'; code: string }>;
}>;

export type SessionFollowObserverV1 =
  | Readonly<{ kind: 'destination_session'; destinationSessionId: string }>
  | Readonly<{ kind: 'account_voice'; accountId: string; voiceSessionId: string }>;

function resolveSessionFollowHydrationReadMode(input: Readonly<{
  observer: SessionFollowObserverV1;
  voiceExpected?: SessionFollowPendingObservationV1['delivered'] | null;
}>): SessionFollowHydrationReadModeV1 {
  return input.observer.kind === 'account_voice' && input.voiceExpected === null
    ? 'initial_current_snapshot'
    : 'incremental';
}

/**
 * Composes the one destination-owned Follow observation with the canonical provider acceptance
 * effect. Hydration is deliberately injected: the Session client owns observe/ACK transport,
 * while the existing Session transcript/awareness and encryption owners remain responsible for
 * reading source content. This helper never creates a Pending row, queue entry, turn, worker,
 * poller, database, ledger, or exactly-once protocol.
 *
 * Guarantees:
 * - The destination is derived from the bound `session.sessionId`; a caller-supplied
 *   destination identity is never trusted. Observations for another destination are omitted.
 * - Hydration is capped to the originally observed frontier. Ordinary Follow advances its
 *   transcript component only through the oldest contiguous messages actually represented.
 *   Account Voice's explicit initial-current-snapshot mode instead acknowledges that exact
 *   observed frontier after one bounded latest projection. A source block omitted by the total
 *   budget is never acknowledged.
 * - `source_unavailable` envelopes remain visible in `updates` but are never acknowledged,
 *   so they stay retryable. Budget-omitted sources are excluded from `updates` and stay pending.
 * - Original publications/questions use their admitted Pending input; configured routes
 *   cannot also inject them as legacy context. The input owner rejoins accepted originals
 *   across route/publisher replacement. No-original Turn facts retain their own
 *   incumbent frontier ACK and at-least-once transport semantics.
 * - Re-admission is enforced by the server observe/ACK owners plus the hydration fetch
 *   immediately before injection; revocation between hydrate and inject fails the final CAS
 *   and leaves the frontier pending.
 */
export function createSessionFollowContextReconciler(input: Readonly<{
  session: ApiSessionClient;
  hydrateObservation: SessionFollowHydrateObservation;
  observer?: SessionFollowObserverV1;
  sourceMaterialController?: SessionFollowSourceMaterialController | null;
  /** Original-input admission through the incumbent Pending owner, not optional prompt context. */
  intakeDiscussionObservation?: (input: Readonly<{ observation: SessionFollowDiscussionPendingObservationV1; signal: AbortSignal }>) => Promise<boolean>;
  /** Evidence-backed allowance from the final provider-context owner; null/absent disables optional Follow. */
  maxFollowContextUtf8Bytes?: number | null;
}>): (options: Readonly<{
  signal: AbortSignal;
  maxFollowContextUtf8Bytes?: number | null;
  deliveryIntent?: 'natural' | 'wake';
  executionRunId?: string;
  followDeliveries?: readonly SessionFollowQueuedDelivery[];
}>) => Promise<SessionFollowReconciledContext | null> {
  // Retain unsettled acceptance requests through typed retryable refusals.
  // The durable edge remains authoritative after success or a terminal refusal.
  type PendingAcknowledgement = Readonly<{
    observation: SessionFollowPendingObservationV1;
    publisherGeneration: string;
    workerObservation?: SessionFollowPendingObservationV1;
    retry: () => Promise<void>;
  }>;
  const pendingAcknowledgements = new Set<PendingAcknowledgement>();
  const isTurnWorkerUpdate = (observation: SessionFollowPendingObservationV1, update: WorkerUpdateV1 | undefined): boolean =>
    !('kind' in observation) && observation.observed.turn !== null
    && update !== undefined
    && update.wake !== 'published' && !(update.workerKind === 'session' && update.ownerState === 'needs_input');
  type Options = Readonly<{ signal: AbortSignal; maxFollowContextUtf8Bytes?: number | null;
    deliveryIntent?: 'natural' | 'wake'; executionRunId?: string; followDeliveries?: readonly SessionFollowQueuedDelivery[] }>;
  const pendingRunAcknowledgements = new Set<() => Promise<void>>();
  const isUnsettledOriginalAcknowledgement = (error: string) => error === 'retryable'
    || error === 'stale_publisher_generation' || error === 'provider_acceptance_unverified';
  const readAcceptedOriginalPublisherGeneration = async (localInputId: string, delivery: SessionFollowInputV1) => {
    // Input custody survives a publisher replacement. Rejoin that exact input
    // under the current socket; its immutable represented prefix stays intact.
    const current = await input.session.observePendingSessionFollow({ inputLocalIds: [localInputId] });
    if (!current.ok || !current.observations.some(observation => 'kind' in observation
      && observation.localInputId === localInputId && observation.destinationSessionId === input.session.sessionId
      && sameStrictJsonValue(observation.delivery, delivery))) return null;
    return current.publisherGeneration;
  };
  const reconcileSessions = async ({ signal, maxFollowContextUtf8Bytes: invocationAllowance, deliveryIntent = 'natural', executionRunId, followDeliveries = [] }: Options,
    withdrawnFollowLocalInputIds: string[]): Promise<SessionFollowReconciledContext | null> => {
    if (signal.aborted) return null;
    // Reuse the host's next preparation boundary; no rearm/timer or second
    // native effect is needed to finish an already accepted input's ACK.
    await Promise.all([...pendingAcknowledgements].map(request => request.retry()));
    if (signal.aborted) return null;
    const observer = input.observer ?? {
      kind: 'destination_session' as const,
      destinationSessionId: input.session.sessionId,
    };
    const maxFollowContextUtf8Bytes = invocationAllowance !== undefined
      ? invocationAllowance
      : input.maxFollowContextUtf8Bytes ?? null;
    const canAdmitFollowContext = maxFollowContextUtf8Bytes !== null
      && Number.isSafeInteger(maxFollowContextUtf8Bytes)
      && maxFollowContextUtf8Bytes > 0;
    if (!canAdmitFollowContext && !input.sourceMaterialController && !input.intakeDiscussionObservation) {
      return null;
    }
    if (observer.kind === 'account_voice' && !executionRunId?.trim()) return null;
    /**
     * The one server admission observation. It runs before hydration, again after
     * hydration immediately before injection, and — for a queued wake — again at
     * the final dispatch boundary. It also retains authoritative source material.
     */
    const observeAdmission = async (
      wakeAdmission?: Omit<NonNullable<SessionFollowObservePendingRequestV1['wakeAdmission']>, 'autonomousCheckIn'>,
      intakeDiscussion = false,
    ): Promise<SessionFollowAdmissionObservation | null> => {
      let current: SessionFollowAdmissionObservation;
      try {
        if (observer.kind === 'account_voice') {
          const voice = await input.session.observePendingAccountVoiceFollow({ executionRunId: executionRunId! }, { signal });
          current = voice.ok ? {
            ok: true,
            publisherGeneration: voice.publisherGeneration,
            executionRunOccurrenceId: voice.executionRunOccurrenceId,
            observations: voice.observations.map((entry) => ({
              sourceSessionId: entry.sourceSessionId,
              destinationSessionId: entry.voiceSessionId,
              relation: 'follower' as const,
              delivered: entry.expected ?? SESSION_FOLLOW_ZERO_FRONTIER_V1,
              observed: entry.observed,
              policy: entry.policy ?? { preset: 'quiet' as const },
              ...(entry.policy ? { voicePolicySelected: true } : {}),
              voiceExpected: entry.expected,
            })),
          } : { ok: false };
        } else {
          const response = await input.session.observePendingSessionFollow({ signal,
            ...(followDeliveries.length ? { inputLocalIds: followDeliveries.map(delivery => delivery.localInputId) } : {}),
            ...(wakeAdmission ? { wakeAdmission } : {}) });
          if (response.ok && intakeDiscussion && input.intakeDiscussionObservation) {
            for (const observation of response.observations) {
              if (!('source' in observation)) continue;
              try { await input.intakeDiscussionObservation({ observation, signal }); }
              catch { logger.debug('[Session Follow] Discussion original input remains unadmitted'); }
            }
          }
          current = response.ok ? { ...response, observations: response.observations.filter(
            (observation): observation is SessionFollowPendingObservationV1 => 'sourceSessionId' in observation,
          ) } : response;
        }
      } catch (error) {
        if (followDeliveries.length > 0) {
          const preparationError = classifyHomeReadPreparationError(error);
          if (preparationError instanceof PromptStackPreparationError) throw preparationError;
        }
        // Follow is optional host context. Home unavailable, unsupported runtime, or a
        // test double without Follow transport must never break the real admitted turn.
        if (wakeAdmission) logger.debug('[Session Follow] Wake admission unavailable before provider effect', {
          error: error instanceof Error ? error.message : 'unknown_error',
        });
        return null;
      }
      if (observer.kind === 'destination_session' && current.ok && current.currentSourceSessionIds) {
        input.sourceMaterialController?.retainSources(current.currentSourceSessionIds);
      }
      return current;
    };
    const observedOrNull = await observeAdmission(undefined, true);
    if (!observedOrNull?.ok) return null;
    const observed = observedOrNull;
    /** The exact edge, frontier, policy and publisher this context was prepared from are still admitted. */
    const isStillAdmitted = (
      current: SessionFollowAdmissionObservation | null,
      observation: SessionFollowAdmissionObservationEntry,
    ): boolean => Boolean(
      current?.ok
      && current.publisherGeneration === observed.publisherGeneration
      && current.executionRunOccurrenceId === observed.executionRunOccurrenceId
      && current.observations?.some((entry) => (
        entry.sourceSessionId === observation.sourceSessionId
        && entry.destinationSessionId === observation.destinationSessionId
        && entry.relation === observation.relation
        && entry.attachedAt === observation.attachedAt
        && ('kind' in observation
          ? 'kind' in entry && entry.localInputId === observation.localInputId
            && sameStrictJsonValue(entry.delivery, observation.delivery)
            && isSessionFollowFrontierEqualV1(entry.observed, observation.observed)
            && (entry.effectiveDelivery === 'wake' || deliveryIntent !== 'wake' && entry.effectiveDelivery === 'next_turn')
          : !('kind' in entry) && (observation.relation === 'rule'
            ? entry.relation === 'rule' && entry.effectiveDelivery === observation.effectiveDelivery
              && sameStrictJsonValue(entry.presence, observation.presence)
            : entry.relation !== 'rule' && isFollowPolicyEqualV1(entry.policy, observation.policy)))
        && isSessionFollowFrontierEqualV1(entry.delivered, observation.delivered)
        // A presence-derived stall is withdrawable until dispatch; numeric
        // transcript progress must not keep a recovered own turn admissible.
        && (observation.observed.turn?.status !== 'stalled'
          || isSessionFollowTurnEqualV1(entry.observed.turn, observation.observed.turn))
        && (
          observer.kind !== 'account_voice'
          || (
            entry.voiceExpected === null
              ? observation.voiceExpected === null
              : entry.voiceExpected !== undefined
                && observation.voiceExpected !== null
                && observation.voiceExpected !== undefined
                && isSessionFollowFrontierEqualV1(entry.voiceExpected, observation.voiceExpected)
          )
        )
      )),
    );
    if (!canAdmitFollowContext) return null;
    if (!observed.publisherGeneration || !observed.observations || observed.observations.length === 0) return null;
    const publisherGeneration = observed.publisherGeneration;
    const destinationSessionId = (input.session as Pick<ApiSessionClient, 'sessionId'>).sessionId;
    const recordOriginalWithdrawal = (observation: SessionFollowPendingObservationV1, isWithdrawn?: () => boolean) => {
      if ('kind' in observation && isWithdrawn?.()
        && followDeliveries.some(delivery => delivery.localInputId === observation.localInputId
          && sameStrictJsonValue(delivery.delivery, observation.delivery))
        && !withdrawnFollowLocalInputIds.includes(observation.localInputId)) {
        withdrawnFollowLocalInputIds.push(observation.localInputId);
      }
    };
    const isAwaitingAcknowledgement = (observation: SessionFollowPendingObservationV1, update: WorkerUpdateV1 | undefined): boolean => {
      for (const pending of pendingAcknowledgements) {
        const represented = pending.workerObservation ?? pending.observation;
        if ((pending.publisherGeneration === publisherGeneration || 'kind' in represented)
          && represented.sourceSessionId === observation.sourceSessionId
          && represented.destinationSessionId === observation.destinationSessionId
          && (pending.workerObservation
            ? (observation.relation !== 'manager' || isTurnWorkerUpdate(observation, update)
              && represented.attachedAt === observation.attachedAt)
              && isSessionFollowTurnEqualV1(represented.observed.turn, observation.observed.turn)
            : represented.relation === observation.relation && represented.attachedAt === observation.attachedAt
              && ('kind' in represented ? 'kind' in observation && represented.localInputId === observation.localInputId
                : !('kind' in observation) && (represented.relation === 'rule'
                  ? observation.relation === 'rule' && represented.effectiveDelivery === observation.effectiveDelivery
                    && sameStrictJsonValue(represented.presence, observation.presence)
                  : observation.relation !== 'rule' && isFollowPolicyEqualV1(represented.policy, observation.policy)))
              && isSessionFollowFrontierEqualV1(represented.delivered, observation.delivered))) return true;
      }
      return false;
    };

    const cooperatingWorkerSources = new Set(observed.observations.filter(observation => observation.relation === 'manager'
      || !('kind' in observation) && observation.observed.turn?.status === 'stalled'
        && (observation.relation === 'rule' ? observation.effectiveDelivery === 'wake'
          : resolveFollowDeliveryV1({ policies: [observation.policy], event: { kind: 'stalled' } }).session.wake))
      .map(observation => observation.sourceSessionId));
    // Destination original records enter through the admitted-input owner. The
    // configured routes still establish membership/currentness, but cannot also
    // turn those records into optional context after their Pending disappears.
    // Account Voice retains its separate source/read lifetime. Stalled Turns
    // and manager waiting Turns have no original-input representation.
    const candidateObservations = observed.observations.filter(observation => observer.kind === 'account_voice'
      || ('kind' in observation ? observation.effectiveDelivery === 'wake' || observation.effectiveDelivery === 'next_turn'
        : (observation.observed.turn?.status === 'stalled'
          || observation.relation === 'manager' && observation.observed.turn?.status === 'waiting')
        && !(observation.observed.turn?.status === 'waiting'
        && observed.observations!.some(original => 'kind' in original
          && followDeliveries.some(queued => queued.localInputId === original.localInputId
            && sameStrictJsonValue(queued.delivery, original.delivery))
          && 'sourceSessionId' in original.delivery.original
          && original.delivery.original.sourceSessionId === observation.sourceSessionId
          && 'sourceRequests' in original.delivery.original && original.delivery.original.sourceRequests.requests.some(request =>
            request.turnId === observation.observed.turn?.id)))));
    const hydrated = await Promise.all(candidateObservations.map(async (observation) => {
      if (signal.aborted) return null;
      if (observation.destinationSessionId !== destinationSessionId) return null;
      if (observation.sourceSessionId === observation.destinationSessionId) return null;
      // Unrequested originals are exact, server-verified accepted-input rejoin
      // observations. Open their source witness for correlation only; they never
      // become rendering, represented-input or ACK candidates again.
      const queuedOriginal = 'kind' in observation
        ? followDeliveries.find(delivery => delivery.localInputId === observation.localInputId) : undefined;
      if (queuedOriginal && 'kind' in observation && !sameStrictJsonValue(queuedOriginal.delivery, observation.delivery)) return null;
      const acceptedOriginalRejoin = 'kind' in observation && !queuedOriginal;
      try {
        const readMode = resolveSessionFollowHydrationReadMode({
          observer,
          voiceExpected: observation.voiceExpected,
        });
        const update = await input.hydrateObservation({
          observation,
          signal,
          readMode,
          ...(observation.voicePolicySelected ? { selectionChannel: 'voice' as const } : {}),
          ...(deliveryIntent === 'wake' ? { discoverHumanIngress: true } : {}),
        });
        if (!update) return null;
        if (update.edge.sourceSessionId !== observation.sourceSessionId) return null;
        if (update.edge.destinationSessionId !== observation.destinationSessionId) return null;
        if (update.awareness.sessionId !== observation.sourceSessionId) return null;
        recordOriginalWithdrawal(observation, update.isOriginalRequestWithdrawn);
        if ('kind' in observation && withdrawnFollowLocalInputIds.includes(observation.localInputId)) return null;
        if (
          update.observed.transcriptSeq < observation.delivered.transcriptSeq
          || update.observed.transcriptSeq > observation.observed.transcriptSeq
          || !isSessionFollowFrontierEqualV1(
            { ...update.observed, transcriptSeq: observation.observed.transcriptSeq,
              // Original publication progress precedes the separate terminal
              // outcome. Only the incumbent delivered turn may be retained.
              ...(observation.relation === 'manager' && isSessionFollowTurnEqualV1(update.observed.turn, observation.delivered.turn)
                ? { turn: observation.observed.turn } : {}) },
            observation.observed,
          )
        ) return null;
        // A wake needs protected human ingress somewhere in the pending range, not
        // necessarily in the one page delivered now (09D §6.2/§6.3): delivery stays
        // the oldest contiguous prefix and only that prefix is acknowledged.
        if (
          deliveryIntent === 'wake'
          && !acceptedOriginalRejoin
          && observation.relation !== 'manager'
          && !cooperatingWorkerSources.has(observation.sourceSessionId)
          && !shouldWakeForSessionFollowObservation(observation, update)
        ) return null;
        const {
          sourceRecencyMs = 0,
          transcriptConsumedThroughByRenderedMessageCount,
          pendingHumanIngress: _pendingHumanIngress,
          workerUpdate,
          recheckWorkerUpdateAdmission,
          isOriginalRequestWithdrawn,
          ...rawPromptUpdate
        } = update;
        if (transcriptConsumedThroughByRenderedMessageCount !== undefined) {
          const checkpoints = transcriptConsumedThroughByRenderedMessageCount;
          if (
            checkpoints.length !== update.recentMessages.length + 1
            || checkpoints.some((seq) => !Number.isSafeInteger(seq))
            || (readMode === 'incremental' && checkpoints[0]! < observation.delivered.transcriptSeq)
            || checkpoints[checkpoints.length - 1] !== update.observed.transcriptSeq
            || checkpoints.some((seq, index) => index > 0 && seq < checkpoints[index - 1]!)
            || update.recentMessages.some((message, index) => (
              (index > 0 && message.seq <= update.recentMessages[index - 1]!.seq)
              || checkpoints[index]! >= message.seq
              || checkpoints[index + 1]! < message.seq
            ))
          ) return null;
        }
        const promptUpdate = deliveryIntent === 'wake'
          ? { ...rawPromptUpdate, reason: 'human_changed_source' as const, deliveryIntent: 'wake' as const }
          : rawPromptUpdate;
        if (observer.kind === 'destination_session' && observation.relation === 'manager' && !workerUpdate) return null;
        return { update: promptUpdate, sourceRecencyMs, transcriptConsumedThroughByRenderedMessageCount, readMode, workerUpdate, recheckWorkerUpdateAdmission,
          acceptedOriginalRejoin, isOriginalRequestWithdrawn,
          mayWake: shouldWakeForSessionFollowObservation(observation, update) };
      } catch (error) {
        // A queued original is required input, so its unavailable Home read must
        // retain that input in the host's existing preparation-recovery custody.
        if (queuedOriginal && error instanceof PromptStackPreparationError) throw error;
        // Follow is optional host context. An unavailable source remains unacknowledged and can
        // be retried by a later accepted turn through the same canonical observation owner.
        return null;
      }
    }));
    const admitted = candidateObservations.flatMap((observation, index) => {
      const update = hydrated[index];
      return update ? [{ observation, ...update }] : [];
    });
    if (signal.aborted || admitted.length === 0) return null;

    // Re-enter the server admission owner after content hydration and immediately
    // before prompt injection. A revoked/replaced edge, broadened/public audience,
    // publisher handoff, or lost destination input authority omits optional context
    // without rejecting the real turn.
    const readmitted = await observeAdmission();
    if (signal.aborted) return null;
    const readmittedEntries = (await Promise.all(admitted.map(async (entry) => {
      if (!isStillAdmitted(readmitted, entry.observation)) return null;
      if (entry.recheckWorkerUpdateAdmission && !await entry.recheckWorkerUpdateAdmission(signal)) {
        recordOriginalWithdrawal(entry.observation, entry.isOriginalRequestWithdrawn);
        return null;
      }
      if (isAwaitingAcknowledgement(entry.observation, entry.workerUpdate)) return null;
      return entry;
    }))).flatMap(entry => entry ? [entry] : []);
    if (signal.aborted) return null;
    const stillAdmitted = readmittedEntries.filter(entry => !entry.acceptedOriginalRejoin);
    if (stillAdmitted.length === 0) return null;

    // Originals enter once through admitted input. No-original Turn facts and
    // Account Voice retain their own read paths.
    const followCandidates = stillAdmitted.filter(({ observation, workerUpdate }) => 'kind' in observation || !workerUpdate);
    // Each Pending already names one original. Keep distinct originals in the
    // budget even when they share a source; this is only a local presentation
    // address, not another occurrence identity or acceptance store.
    const budgetKey = (observation: SessionFollowPendingObservationV1) => JSON.stringify('kind' in observation
      ? ['admitted_input', observation.localInputId] : ['source', observation.sourceSessionId]);
    const followBySource = new Map(followCandidates.map(entry => [budgetKey(entry.observation), entry] as const));
    const followAdmitted = [...followBySource.values()];
    let remainingBytes = maxFollowContextUtf8Bytes;
    const wakingWorkerSources = new Set(stillAdmitted.filter(entry => entry.mayWake).map(entry => entry.observation.sourceSessionId));
    const fittedWorkers = new Map<string, WorkerUpdateV1>();
    const workerPrepared = stillAdmitted.flatMap((entry) => {
      const { observation, update, workerUpdate, recheckWorkerUpdateAdmission } = entry;
      if ('kind' in observation) return [];
      // Required transcript originals keep their existing Pending order. A
      // later optional manager outcome cannot spend or ACK past their prefix.
      // Foreground questions retain their separate exact-Turn witness rule.
      if (followDeliveries.some(({ delivery }) => 'sourceMessage' in delivery.original
        && delivery.original.sourceSessionId === observation.sourceSessionId)) return [];
      if (!workerUpdate || deliveryIntent === 'wake' && !wakingWorkerSources.has(observation.sourceSessionId)) return [];
      const event = classifyWorkerUpdateEventV1(workerUpdate);
      if (!event || (observation.relation === 'rule' ? event !== 'stalled' : !resolveFollowDeliveryV1({ policies: [observation.policy], event: event === 'needs_you'
        ? { kind: event, type: update.awareness.operational.primary === 'permission_required' ? 'approval'
          : update.awareness.operational.reasons.includes('blocked_input') ? 'blocked' : 'decision' }
        : { kind: event } }).selected)) return [];
      const shared = fittedWorkers.get(observation.sourceSessionId);
      const fitted = shared ?? fitWorkerUpdateWithinHostContextAllowance(workerUpdate, Math.max(0, remainingBytes - 2));
      if (!fitted) return [];
      if (!shared) {
        fittedWorkers.set(observation.sourceSessionId, fitted);
        remainingBytes -= measureSessionFollowUtf8Bytes(renderWorkerUpdatePromptBlockV1(fitted)) + 2;
      }
      return [{ observation, update, workerUpdate: fitted, recheckWorkerUpdateAdmission, ackable: update.reason !== 'source_unavailable' }];
    });
    const workerGroups = new Map<string, typeof workerPrepared>();
    for (const entry of workerPrepared) {
      const group = workerGroups.get(entry.observation.sourceSessionId);
      if (group) group.push(entry);
      else workerGroups.set(entry.observation.sourceSessionId, [entry]);
    }
    const renderedWorkers = [...workerGroups.values()].map(group => group[0]!);
    const originalProjection = (entry: typeof followAdmitted[number], keptSeqs: readonly number[], truncated: boolean) => {
      const consumedTranscriptSeq = entry.readMode === 'initial_current_snapshot'
        ? entry.observation.observed.transcriptSeq
        : entry.transcriptConsumedThroughByRenderedMessageCount?.[keptSeqs.length]
          ?? keptSeqs[keptSeqs.length - 1]
          ?? entry.observation.delivered.transcriptSeq;
      const workerUpdate = 'kind' in entry.observation ? entry.workerUpdate : undefined;
      const messages = entry.update.recentMessages.filter(message => keptSeqs.includes(message.seq));
      const renderFollow = !workerUpdate || messages.length > 0;
      return { workerUpdate, renderFollow, consumedTranscriptSeq, update: { ...entry.update, recentMessages: messages, truncated } };
    };
    let budget: ReturnType<typeof applySessionFollowContextBudgetV1>;
    try {
      budget = applySessionFollowContextBudgetV1({
        candidates: followAdmitted.map((entry) => {
          const { observation, update, sourceRecencyMs, readMode } = entry;
          return ({
          sourceSessionId: observation.sourceSessionId,
          candidateId: budgetKey(observation),
          ...('kind' in observation && 'sourceMessage' in observation.delivery.original
            ? { sourceOriginalSeq: observation.delivery.original.sourceMessage.seq } : {}),
          sourceRecencyMs,
          actionableAttention: update.awareness.operational.primary === 'failed'
            || update.awareness.operational.primary === 'action_required'
            || update.awareness.operational.primary === 'permission_required',
          recentMessages: update.recentMessages.map((message) => ({ seq: message.seq, text: message.text })),
          messageSelection: readMode === 'initial_current_snapshot'
            ? 'latest_current_suffix' as const
            : 'oldest_pending_prefix' as const,
          truncated: update.truncated,
          render: ({ keptMessageSeqs, truncated }) => {
            const projection = originalProjection(entry, keptMessageSeqs, truncated);
            return `${renderSessionInputContextPromptV1({
              sessionFollowUpdates: projection.renderFollow ? [projection.update] : [],
              ...(projection.workerUpdate ? { workerUpdates: [projection.workerUpdate] } : {}),
              transformedUserText: '',
            })}\n\n`;
          },
        }); }),
        maxUtf8Bytes: remainingBytes,
      });
    } catch {
      // Invalid or concurrently unreadable optional context cannot reject the admitted input.
      return null;
    }
    const followPrepared = [...budget.keptBySource.keys()].flatMap((sourceSessionId) => {
      const entry = followBySource.get(sourceSessionId);
      if (!entry) return [];
      const { observation, update } = entry;
      if (budget.omittedSources.includes(sourceSessionId)) return [];
      const keptSeqs = budget.keptBySource.get(sourceSessionId);
      const truncated = budget.truncatedBySource.get(sourceSessionId) ?? update.truncated;
      const projection = originalProjection(entry, keptSeqs ?? update.recentMessages.map(message => message.seq), truncated);
      const { consumedTranscriptSeq } = projection;
      if (deliveryIntent === 'wake' && !entry.mayWake) return [];
      const filtered = { ...projection.update, observed: { ...update.observed, transcriptSeq: consumedTranscriptSeq } };
      const ackable = filtered.reason !== 'source_unavailable'
        && (
          (observer.kind === 'account_voice' && observation.voiceExpected === null)
          || compareSessionFollowFrontierProgressV1(observation.delivered, filtered.observed) === 'ahead'
        );
      const primary = { observation, update: filtered,
        workerUpdate: 'kind' in observation ? projection.workerUpdate : undefined,
        recheckWorkerUpdateAdmission: 'kind' in observation ? entry.recheckWorkerUpdateAdmission : undefined,
        isOriginalRequestWithdrawn: entry.isOriginalRequestWithdrawn,
        ackable, renderFollow: projection.renderFollow };
      return [primary];
    });
    // Per-original Pending custody does not make a later selected original a
    // contiguous prefix. If an earlier selected input was unavailable or could
    // not fit, neither native acceptance nor its ACK may jump over that gap.
    // This is the bounded observation set already being prepared, not a source
    // history scan; unselected source rows impose no ordering requirement.
    const completeOriginals = new Set(followPrepared.flatMap(entry => entry.ackable && 'kind' in entry.observation
      && isSessionFollowFrontierEqualV1(entry.update.observed, entry.observation.observed)
      ? [entry.observation.localInputId] : []));
    const firstUnrepresentedBySource = new Map<string, number>();
    for (const observation of candidateObservations) {
      if (!('kind' in observation) || !('sourceMessage' in observation.delivery.original)
        || !followDeliveries.some(delivery => delivery.localInputId === observation.localInputId
          && sameStrictJsonValue(delivery.delivery, observation.delivery))
        || completeOriginals.has(observation.localInputId)) continue;
      const seq = observation.delivery.original.sourceMessage.seq;
      firstUnrepresentedBySource.set(observation.sourceSessionId,
        Math.min(seq, firstUnrepresentedBySource.get(observation.sourceSessionId) ?? seq));
    }
    const prefixPrepared = followPrepared.filter(({ observation }) => {
      if (!('kind' in observation) || !('sourceMessage' in observation.delivery.original)) return true;
      const gap = firstUnrepresentedBySource.get(observation.sourceSessionId);
      return gap === undefined || observation.delivery.original.sourceMessage.seq <= gap;
    });
    const prepared = [...workerPrepared, ...prefixPrepared];
    if (prepared.length === 0) return null;
    // Native readers know only the public intent. The server joins private route
    // witnesses from this exact input; a budget-truncated original is not accepted.
    const representedDeliveries = followDeliveries.filter(delivery => prepared.some(entry => entry.ackable
      && 'kind' in entry.observation && entry.observation.localInputId === delivery.localInputId
      && sameStrictJsonValue(entry.observation.delivery, delivery.delivery)
      && isSessionFollowFrontierEqualV1(entry.update.observed, entry.observation.observed)));

    const wakeCandidates = prepared.flatMap(({ observation, update }) => 'kind' in observation ? [] : [{
          sourceSessionId: observation.sourceSessionId,
          ...(observation.relation === 'rule' ? { relation: observation.relation,
            effectiveDelivery: observation.effectiveDelivery, presence: observation.presence }
            : { policy: observation.policy, relation: observation.relation, attachedAt: observation.attachedAt }),
          expected: observation.delivered,
          consumed: update.observed,
        }]);
    const wakeObservations = deliveryIntent === 'wake' && wakeCandidates.length
      ? normalizeSessionFollowWakeObservationsV1(wakeCandidates)
      : undefined;
    const wakeEventLocalId = wakeObservations?.length
      ? deriveSessionFollowWakeEventLocalIdV1({
          destinationSessionId,
          publisherGeneration,
          observations: wakeObservations,
        })
      : undefined;

    return {
      withdrawnFollowLocalInputIds,
      ...(representedDeliveries.length ? { representedFollowLocalInputIds: representedDeliveries.map(delivery => delivery.localInputId) } : {}),
      updates: prefixPrepared.filter(entry => entry.renderFollow).map(({ update }) => update),
      ...(prepared.some(entry => entry.workerUpdate) ? {
        workerUpdates: [...renderedWorkers.map(entry => entry.workerUpdate),
          ...prefixPrepared.flatMap(entry => entry.workerUpdate ? [entry.workerUpdate] : [])],
      } : {}),
      ...((deliveryIntent === 'wake' && workerPrepared.length) || prefixPrepared.some(entry => entry.workerUpdate && 'kind' in entry.observation) ? {
        workerUpdateEvents: [...(deliveryIntent === 'wake' ? renderedWorkers : []).map(({ observation, update, workerUpdate }) => ({
          localId: deriveSessionFollowWakeEventLocalIdV1({
            destinationSessionId, publisherGeneration,
            observations: [{ sourceSessionId: observation.sourceSessionId,
              ...(observation.relation === 'rule' ? { relation: observation.relation,
                effectiveDelivery: observation.effectiveDelivery, presence: observation.presence }
                : { relation: observation.relation, policy: observation.policy, attachedAt: observation.attachedAt }),
              expected: observation.delivered, consumed: update.observed }],
          }),
          update: workerUpdate,
          followMatches: workerGroups.get(observation.sourceSessionId)!
            .map(entry => entry.observation.relation === 'rule' ? { kind: 'rule' as const }
              : { kind: 'relation' as const, relation: entry.observation.relation }),
        })), ...prefixPrepared.flatMap(({ observation, workerUpdate }) => {
          if (!('kind' in observation) || !workerUpdate) return [];
          const queued = representedDeliveries.find(delivery => delivery.localInputId === observation.localInputId);
          if (!queued) return [];
          return [{ localId: buildAgentEventLocalId('worker-update', ['follow', deriveSessionFollowInputLocalIdV1({
              destinationSessionId, original: queued.delivery.original,
            })]),
            update: workerUpdate, followInputLocalId: queued.localInputId,
            ...(queued.followMatches?.length ? { followMatches: queued.followMatches } : {}) }];
        })],
      } : {}),
      ...(wakeEventLocalId ? { wakeEventLocalId } : {}),
      recheckAdmission: async (dispatchSignal) => {
        if (signal.aborted || dispatchSignal.aborted) return false;
        const current = await observeAdmission(deliveryIntent === 'wake' && wakeEventLocalId && wakeObservations
          ? { eventLocalId: wakeEventLocalId, observations: wakeObservations }
          : undefined);
        if (signal.aborted || dispatchSignal.aborted) return false;
        if (deliveryIntent === 'wake' && wakeEventLocalId && current?.wakeAdmission?.status !== 'allowed') {
          logger.debug('[Session Follow] Wake held before provider effect', {
            reason: current?.wakeAdmission?.status === 'held'
              ? current.wakeAdmission.code : 'admission_unavailable',
          });
          return false;
        }
        // All or nothing: the wake event identity and its ACK name every represented
        // source, so a context that lost any of them is withdrawn rather than narrowed.
        const allowed = await Promise.all(prepared.map(async entry => {
          const { observation, workerUpdate, recheckWorkerUpdateAdmission } = entry;
          if (!isStillAdmitted(current, observation)) return false;
          if (recheckWorkerUpdateAdmission && !await recheckWorkerUpdateAdmission(dispatchSignal)) {
            recordOriginalWithdrawal(observation, 'isOriginalRequestWithdrawn' in entry ? entry.isOriginalRequestWithdrawn : undefined);
            return false;
          }
          return !isAwaitingAcknowledgement(observation, workerUpdate);
        }));
        return !signal.aborted && !dispatchSignal.aborted && allowed.every(Boolean);
      },
      acknowledgeAccepted: (acceptance, pendingSettlement) => {
        if (
          acceptance.kind === 'context_only_wake'
          && acceptance.eventLocalId !== wakeEventLocalId
        ) return;
        const localInputId = acceptance.kind === 'context_only_wake'
          ? acceptance.eventLocalId
          : acceptance.localInputId;
        const userMessageSeq = acceptance.kind === 'context_only_wake' ? null : acceptance.userMessageSeq;
        if (signal.aborted) return;
        const accepted = prepared.filter(({ observation, workerUpdate, ackable }) => ackable
          && !isAwaitingAcknowledgement(observation, workerUpdate)
          && (!('kind' in observation) || acceptance.kind === 'admitted_input' && representedDeliveries.some(delivery =>
            delivery.localInputId === localInputId && delivery.userMessageSeq === userMessageSeq
            && delivery.localInputId === observation.localInputId)));
        for (const { observation, update, workerUpdate } of accepted) {
          const workerObservation = isTurnWorkerUpdate(observation, workerUpdate) ? observation : undefined;
          const consumed = update.observed;
          let inFlight = false;
          const request: PendingAcknowledgement = { observation, publisherGeneration, workerObservation, retry: async () => {
            if (inFlight || !pendingAcknowledgements.has(request)) return;
            inFlight = true;
            const startedAtMs = Date.now();
            const acknowledgementFacts = { destinationSessionId, sourceSessionId: observation.sourceSessionId,
              localInputId, userMessageSeq, expected: observation.delivered, consumed };
            try {
              if (pendingSettlement) await pendingSettlement;
              const currentPublisherGeneration = 'kind' in observation
                ? await readAcceptedOriginalPublisherGeneration(observation.localInputId, observation.delivery)
                : publisherGeneration;
              if (!currentPublisherGeneration) return;
              logger.debug('[Session Follow] Acceptance ACK started', { ...acknowledgementFacts,
                expectedPublisherGeneration: currentPublisherGeneration });
              const result = await (observer.kind === 'account_voice'
                ? input.session.acknowledgeAccountVoiceFollow({
                    executionRunId: executionRunId!,
                    expectedExecutionRunOccurrenceId: observed.executionRunOccurrenceId!,
                    sourceSessionId: observation.sourceSessionId,
                    expectedPublisherGeneration: currentPublisherGeneration,
                    expected: observation.voiceExpected ?? null,
                    observed: observation.observed,
                    consumed,
                    ...(observation.voicePolicySelected && observation.policy ? { policy: observation.policy } : {}),
                    acceptance: { localInputId, userMessageSeq },
                  })
                : input.session.acknowledgeSessionFollow('kind' in observation ? {
                    sourceSessionId: observation.sourceSessionId,
                    localInputId: observation.localInputId,
                    expectedPublisherGeneration: currentPublisherGeneration,
                    expected: observation.delivered, observed: observation.observed, consumed,
                    acceptance: { kind: 'admitted_input', localInputId, userMessageSeq },
                  } : {
                    sourceSessionId: observation.sourceSessionId,
                    ...(observation.relation === 'rule' ? { relation: observation.relation,
                      effectiveDelivery: observation.effectiveDelivery, presence: observation.presence }
                      : { policy: observation.policy, relation: observation.relation, attachedAt: observation.attachedAt }),
                    expectedPublisherGeneration: publisherGeneration,
                    expected: observation.delivered,
                    observed: observation.observed,
                    consumed,
                    acceptance: acceptance.kind === 'context_only_wake'
                      ? { ...acceptance, observations: wakeObservations! }
                      : { kind: 'admitted_input', localInputId, userMessageSeq },
                  }));
              logger.debug('[Session Follow] Acceptance ACK completed', { ...acknowledgementFacts,
                expectedPublisherGeneration: currentPublisherGeneration,
                elapsedMs: Date.now() - startedAtMs, ok: result.ok,
                ...(!result.ok ? { rejection: 'rejection' in result ? result.rejection : result.error } : {}) });
              const rejection = result.ok ? null : result.error;
              if (result.ok || !(rejection === 'retryable'
                || 'kind' in observation && rejection !== null && isUnsettledOriginalAcknowledgement(rejection))) {
                pendingAcknowledgements.delete(request);
              }
            } catch {
              if (!('kind' in observation)) pendingAcknowledgements.delete(request);
              // Originals retain exact accepted-input custody for the next
              // boundary. No-original wakes keep their at-least-once path.
              logger.debug('[Session Follow] Acceptance ACK failed', { ...acknowledgementFacts, elapsedMs: Date.now() - startedAtMs });
            } finally { inFlight = false; }
          } };
          // Every covered route keeps the same worker acceptance in custody;
          // a successful manager ACK cannot release an ordinary route's retry.
          pendingAcknowledgements.add(request);
          void request.retry();
        }
      },
    };
  };
  return async options => {
    await Promise.all([...pendingRunAcknowledgements].map(retry => retry()));
    const withdrawnFollowLocalInputIds: string[] = [];
    const queued = (options.followDeliveries ?? []).filter(entry => 'source' in entry.delivery.original);
    const preparedSessions = await reconcileSessions({ ...options,
      followDeliveries: (options.followDeliveries ?? []).filter(entry => 'sourceSessionId' in entry.delivery.original) }, withdrawnFollowLocalInputIds);
    const sessions: SessionFollowReconciledContext | null = preparedSessions ?? (withdrawnFollowLocalInputIds.length ? {
      updates: [], withdrawnFollowLocalInputIds,
      recheckAdmission: async (signal: AbortSignal) => !signal.aborted && !options.signal.aborted,
      acknowledgeAccepted: () => {},
    } : null);
    if (!queued.length || input.observer?.kind === 'account_voice' || options.signal.aborted) return sessions;
    const observe = async (signal: AbortSignal) => {
      try { return await input.session.observePendingSessionFollow({ signal,
        inputLocalIds: queued.map(entry => entry.localInputId) }); }
      catch (error) {
        const preparationError = classifyHomeReadPreparationError(error);
        if (preparationError instanceof PromptStackPreparationError) throw preparationError;
        return null;
      }
    };
    const observed = await observe(options.signal);
    if (!observed?.ok || options.signal.aborted) return sessions;
    const readWithdrawn = (observations: typeof observed.observations) => {
      for (const entry of queued) if (observations.some(observation => 'kind' in observation
        && observation.kind === 'admitted_run_input' && observation.disposition === 'withdrawn'
        && observation.destinationSessionId === input.session.sessionId && observation.localInputId === entry.localInputId
        && sameStrictJsonValue(observation.delivery, entry.delivery))
        && !withdrawnFollowLocalInputIds.includes(entry.localInputId)) withdrawnFollowLocalInputIds.push(entry.localInputId);
    };
    readWithdrawn(observed.observations);
    const selectsRunIntake = (mode: 'wake' | 'next_turn' | null) => mode === 'wake'
      || options.deliveryIntent !== 'wake' && mode === 'next_turn';
    const indexRuns = (observations: typeof observed.observations) => new Map(observations.flatMap(observation =>
      'kind' in observation && observation.kind === 'admitted_run_input'
        && observation.destinationSessionId === input.session.sessionId ? [[observation.localInputId, observation] as const] : []));
    const observedRuns = indexRuns(observed.observations);
    const runWorkerEvents: NonNullable<SessionFollowPreparedContext['workerUpdateEvents']>[number][] = [];
    let remainingBytes = Math.max(0, (options.maxFollowContextUtf8Bytes ?? input.maxFollowContextUtf8Bytes ?? 0)
      - measureSessionFollowUtf8Bytes(renderSessionInputContextPromptV1({ sessionFollowUpdates: sessions?.updates,
        workerUpdates: sessions?.workerUpdates, transformedUserText: '' })));
    const admitted = queued.filter(entry => {
      const observation = observedRuns.get(entry.localInputId);
      if (!observation || observation.disposition === 'withdrawn' || !selectsRunIntake(observation.effectiveDelivery)
        || !sameStrictJsonValue(observation.delivery, entry.delivery)) return false;
      if (!('terminalEventId' in entry.delivery.original && 'sessionId' in entry.delivery.original.source)) return true;
      const update = observation.workerUpdate;
      // A terminal notice cannot consume its original before the typed outcome
      // reaches the provider. Missing material and budget omissions stay pending.
      if (!update) return false;
      const cost = measureSessionFollowUtf8Bytes(`${renderWorkerUpdatePromptBlockV1(update)}\n\n${renderRunFollowNotice(entry.delivery)}\n`);
      if (cost > remainingBytes) return false;
      remainingBytes -= cost;
      runWorkerEvents.push({ localId: `execution-run-worker-update:${entry.delivery.original.terminalEventId}`,
        update, followInputLocalId: entry.localInputId, ...(entry.followMatches ? { followMatches: entry.followMatches } : {}) });
      return true;
    });
    const runWorkersByInput = new Map(runWorkerEvents.map(event => [event.followInputLocalId, event.update]));
    if (!admitted.length && !withdrawnFollowLocalInputIds.length) return sessions;
    return {
      updates: sessions?.updates ?? [],
      ...(sessions?.workerUpdates || runWorkerEvents.length ? {
        workerUpdates: [...sessions?.workerUpdates ?? [], ...runWorkerEvents.map(event => event.update)],
      } : {}),
      ...(sessions?.workerUpdateEvents || runWorkerEvents.length ? {
        workerUpdateEvents: [...sessions?.workerUpdateEvents ?? [], ...runWorkerEvents],
      } : {}),
      ...(sessions?.wakeEventLocalId ? { wakeEventLocalId: sessions.wakeEventLocalId } : {}),
      representedFollowLocalInputIds: [...(sessions?.representedFollowLocalInputIds ?? []), ...admitted.map(entry => entry.localInputId)],
      withdrawnFollowLocalInputIds,
      recheckAdmission: async signal => {
        if (signal.aborted || options.signal.aborted || sessions && !await sessions.recheckAdmission(signal)) return false;
        const current = await observe(signal);
        if (current?.ok) readWithdrawn(current.observations);
        const currentRuns = current?.ok ? indexRuns(current.observations) : null;
        return !signal.aborted && !options.signal.aborted && current?.ok === true && current.publisherGeneration === observed.publisherGeneration
          && admitted.every(entry => {
            const observation = currentRuns?.get(entry.localInputId);
            const worker = runWorkersByInput.get(entry.localInputId);
            return observation !== undefined && observation.disposition !== 'withdrawn'
              && selectsRunIntake(observation.effectiveDelivery) && sameStrictJsonValue(observation.delivery, entry.delivery)
              && (!worker || sameStrictJsonValue(observation.workerUpdate, worker));
          });
      },
      acknowledgeAccepted: (acceptance, pendingSettlement) => {
        sessions?.acknowledgeAccepted(acceptance, pendingSettlement);
        if (acceptance.kind !== 'admitted_input' || options.signal.aborted) return;
        const entry = admitted.find(entry => entry.localInputId === acceptance.localInputId
          && entry.userMessageSeq === acceptance.userMessageSeq);
        if (!entry || !('source' in entry.delivery.original)) return;
        const original = entry.delivery.original;
        let inFlight = false;
        const retry = async () => {
          if (inFlight || !pendingRunAcknowledgements.has(retry)) return;
          inFlight = true;
          try {
            if (pendingSettlement) await pendingSettlement;
            const publisherGeneration = await readAcceptedOriginalPublisherGeneration(entry.localInputId, entry.delivery);
            if (!publisherGeneration) return;
            const result = await input.session.acknowledgeSessionFollow({ localInputId: entry.localInputId,
              expectedPublisherGeneration: publisherGeneration, original, acceptance });
            if (result.ok || !isUnsettledOriginalAcknowledgement(result.error)) pendingRunAcknowledgements.delete(retry);
          } catch {
            logger.debug('[Session Follow] Run acceptance ACK failed');
          } finally { inFlight = false; }
        };
        pendingRunAcknowledgements.add(retry);
        void retry();
      },
    };
  };
}
