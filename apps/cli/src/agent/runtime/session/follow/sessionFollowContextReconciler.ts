import { compareSessionFollowFrontierProgressV1, isSessionFollowFrontierEqualV1, isSessionFollowTurnEqualV1, SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { deriveSessionFollowWakeEventLocalIdV1, normalizeSessionFollowWakeObservationsV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { isAuthoritativeHumanSessionFollowMessageV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowUpdateEnvelopeV1';
import { renderSessionInputContextPromptV1, renderWorkerUpdatePromptBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { SessionFollowAcknowledgeResponseV1, SessionFollowPendingObservationV1, SessionFollowUpdateEnvelopeV1, WorkerUpdateV1 } from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { SocketAckError } from '@/session/transport/shared/socketAck';

import { applySessionFollowContextBudgetV1 } from './sessionFollowContextBudget';
import { measureSessionFollowUtf8Bytes } from './sessionFollowContextBudget';
import { fitWorkerUpdateWithinHostContextAllowance } from '../contextOnly/hostContextOnlyInput';
import type {
  SessionFollowHydratedUpdate,
  SessionFollowHydrationReadModeV1,
} from './sessionFollowSourceHydrator';
import type { SessionFollowSourceMaterialController } from './sessionFollowSourceMaterialResolver';

export type SessionFollowHydrateObservation = (input: Readonly<{
  observation: SessionFollowPendingObservationV1;
  signal: AbortSignal;
  readMode: SessionFollowHydrationReadModeV1;
  /** Wake discovery: also report whether protected human ingress exists anywhere in the pending range. */
  discoverHumanIngress?: boolean;
}>) => Promise<(SessionFollowUpdateEnvelopeV1 & Partial<Pick<
  SessionFollowHydratedUpdate,
  'sourceRecencyMs' | 'transcriptConsumedThroughByRenderedMessageCount' | 'pendingHumanIngress' | 'workerUpdate' | 'recheckWorkerUpdateAdmission'
>>) | null>;

export type SessionFollowPreparedContext = Readonly<{
  updates: readonly SessionFollowUpdateEnvelopeV1[];
  workerUpdates?: readonly WorkerUpdateV1[];
  /** Per-worker cards share the incumbent frontier identity owner, independently of batch membership. */
  workerUpdateEvents?: readonly Readonly<{ localId: string; update: WorkerUpdateV1 }>[];
  /** Present only for a wake; this is the deterministic durable event identity committed before delivery. */
  wakeEventLocalId?: string;
  acknowledgeAccepted: (input: Readonly<{
    kind: 'admitted_input';
    localInputId: string;
    userMessageSeq: number | null;
  }> | Readonly<{
    kind: 'context_only_wake';
    eventLocalId: string;
  }>) => void;
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
}>;

type SessionFollowAdmissionObservation = Readonly<{
  ok: boolean;
  publisherGeneration?: string;
  executionRunOccurrenceId?: string;
  currentSourceSessionIds?: readonly string[];
  observations?: readonly SessionFollowAdmissionObservationEntry[];
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
 * - Re-admission is enforced by the server observe/ACK owners plus the hydration fetch
 *   immediately before injection; revocation between hydrate and inject fails the final CAS
 *   and leaves the frontier pending.
 */
export function createSessionFollowContextReconciler(input: Readonly<{
  session: ApiSessionClient;
  hydrateObservation: SessionFollowHydrateObservation;
  observer?: SessionFollowObserverV1;
  sourceMaterialController?: SessionFollowSourceMaterialController | null;
  /** Re-arm the existing process-local wake signal only for retryable ACK timeouts. */
  onRetryableTransportFailure?: () => void;
  /** Evidence-backed allowance from the final provider-context owner; null/absent disables optional Follow. */
  maxFollowContextUtf8Bytes?: number | null;
}>): (options: Readonly<{
  signal: AbortSignal;
  maxFollowContextUtf8Bytes?: number | null;
  deliveryIntent?: 'natural' | 'wake';
  executionRunId?: string;
}>) => Promise<SessionFollowReconciledContext | null> {
  return async ({ signal, maxFollowContextUtf8Bytes: invocationAllowance, deliveryIntent = 'natural', executionRunId }) => {
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
    if (!canAdmitFollowContext && !input.sourceMaterialController) {
      return null;
    }
    if (observer.kind === 'account_voice' && !executionRunId?.trim()) return null;
    /**
     * The one server admission observation. It runs before hydration, again after
     * hydration immediately before injection, and — for a queued wake — again at
     * the final dispatch boundary. It also retains authoritative source material.
     */
    const observeAdmission = async (): Promise<SessionFollowAdmissionObservation | null> => {
      let current: SessionFollowAdmissionObservation;
      try {
        if (observer.kind === 'account_voice') {
          const voice = await input.session.observePendingAccountVoiceFollow({ executionRunId: executionRunId! });
          current = voice.ok ? {
            ok: true,
            publisherGeneration: voice.publisherGeneration,
            executionRunOccurrenceId: voice.executionRunOccurrenceId,
            observations: voice.observations.map((entry) => ({
              sourceSessionId: entry.sourceSessionId,
              destinationSessionId: entry.voiceSessionId,
              delivered: entry.expected ?? SESSION_FOLLOW_ZERO_FRONTIER_V1,
              observed: entry.observed,
              mode: 'next_turn',
              voiceExpected: entry.expected,
            })),
          } : { ok: false };
        } else {
          current = await input.session.observePendingSessionFollow();
        }
      } catch (error) {
        // Follow is optional host context. Home unavailable, unsupported runtime, or a
        // test double without Follow transport must never break the real admitted turn.
        if (deliveryIntent === 'wake' && error instanceof SocketAckError && error.code === 'socket_ack_timeout') {
          input.onRetryableTransportFailure?.();
        }
        return null;
      }
      if (observer.kind === 'destination_session' && current.ok && current.currentSourceSessionIds) {
        input.sourceMaterialController?.retainSources(current.currentSourceSessionIds);
      }
      return current;
    };
    const observedOrNull = await observeAdmission();
    if (!observedOrNull?.ok) return null;
    const observed = observedOrNull;
    /** The exact edge, frontier, mode and publisher this context was prepared from are still admitted. */
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
        && entry.edgeKind === observation.edgeKind
        && entry.attachedAt === observation.attachedAt
        && isSessionFollowFrontierEqualV1(entry.delivered, observation.delivered)
        // A presence-derived stall is withdrawable until dispatch; numeric
        // transcript progress must not keep a recovered own turn admissible.
        && (observation.observed.turn?.status !== 'stalled'
          || isSessionFollowTurnEqualV1(entry.observed.turn, observation.observed.turn))
        && entry.mode === observation.mode
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

    const candidateObservations = deliveryIntent === 'wake'
      ? observed.observations.filter((observation) => observation.edgeKind === 'reports_to' || observation.mode === 'wake_on_human_change')
      : observed.observations;
    const hydrated = await Promise.all(candidateObservations.map(async (observation) => {
      if (signal.aborted) return null;
      if (observation.destinationSessionId !== destinationSessionId) return null;
      if (observation.sourceSessionId === observation.destinationSessionId) return null;
      try {
        const readMode = observation.edgeKind === 'reports_to' ? 'initial_current_snapshot' : resolveSessionFollowHydrationReadMode({
          observer,
          voiceExpected: observation.voiceExpected,
        });
        const update = await input.hydrateObservation({
          observation,
          signal,
          readMode,
          ...(deliveryIntent === 'wake' ? { discoverHumanIngress: true } : {}),
        });
        if (!update) return null;
        if (update.edge.sourceSessionId !== observation.sourceSessionId) return null;
        if (update.edge.destinationSessionId !== observation.destinationSessionId) return null;
        if (update.awareness.sessionId !== observation.sourceSessionId) return null;
        if (
          update.observed.transcriptSeq < observation.delivered.transcriptSeq
          || update.observed.transcriptSeq > observation.observed.transcriptSeq
          || !isSessionFollowFrontierEqualV1(
            { ...update.observed, transcriptSeq: observation.observed.transcriptSeq },
            observation.observed,
          )
        ) return null;
        // A wake needs protected human ingress somewhere in the pending range, not
        // necessarily in the one page delivered now (09D §6.2/§6.3): delivery stays
        // the oldest contiguous prefix and only that prefix is acknowledged.
        if (
          deliveryIntent === 'wake'
          && observation.edgeKind !== 'reports_to'
          && !update.recentMessages.some(isAuthoritativeHumanSessionFollowMessageV1)
          && update.pendingHumanIngress !== true
        ) return null;
        const {
          sourceRecencyMs = 0,
          transcriptConsumedThroughByRenderedMessageCount,
          pendingHumanIngress: _pendingHumanIngress,
          workerUpdate,
          recheckWorkerUpdateAdmission,
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
        if (observation.edgeKind === 'reports_to' && !workerUpdate) return null;
        return { update: promptUpdate, sourceRecencyMs, transcriptConsumedThroughByRenderedMessageCount, readMode, workerUpdate, recheckWorkerUpdateAdmission };
      } catch {
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
    const stillAdmitted = (await Promise.all(admitted.map(async (entry) => {
      if (!isStillAdmitted(readmitted, entry.observation)) return null;
      if (entry.recheckWorkerUpdateAdmission && !await entry.recheckWorkerUpdateAdmission(signal)) return null;
      return entry;
    }))).flatMap(entry => entry ? [entry] : []);
    if (signal.aborted) return null;
    if (stillAdmitted.length === 0) return null;

    let remainingBytes = maxFollowContextUtf8Bytes;
    const workerPrepared = stillAdmitted.flatMap(({ observation, update, workerUpdate, recheckWorkerUpdateAdmission }) => {
      if (!workerUpdate) return [];
      const fitted = fitWorkerUpdateWithinHostContextAllowance(workerUpdate, Math.max(0, remainingBytes - 2));
      if (!fitted) return [];
      remainingBytes -= measureSessionFollowUtf8Bytes(renderWorkerUpdatePromptBlockV1(fitted)) + 2;
      return [{ observation, update, workerUpdate: fitted, recheckWorkerUpdateAdmission, ackable: update.reason !== 'source_unavailable' }];
    });
    const followAdmitted = stillAdmitted.filter(({ observation }) => observation.edgeKind !== 'reports_to');
    let budget: ReturnType<typeof applySessionFollowContextBudgetV1>;
    try {
      budget = applySessionFollowContextBudgetV1({
        candidates: followAdmitted.map(({ observation, update, sourceRecencyMs, readMode }) => ({
          sourceSessionId: observation.sourceSessionId,
          sourceRecencyMs,
          actionableAttention: update.awareness.operational.primary === 'failed'
            || update.awareness.operational.primary === 'action_required'
            || update.awareness.operational.primary === 'permission_required',
          recentMessages: update.recentMessages.map((message) => ({ seq: message.seq, text: message.text })),
          messageSelection: readMode === 'initial_current_snapshot'
            ? 'latest_current_suffix' as const
            : 'oldest_pending_prefix' as const,
          truncated: update.truncated,
          render: ({ keptMessageSeqs, truncated }) => `${renderSessionInputContextPromptV1({
            sessionFollowUpdates: [{
              ...update,
              recentMessages: update.recentMessages.filter((message) => keptMessageSeqs.includes(message.seq)),
              truncated,
            }],
            transformedUserText: '',
          })}\n\n`,
        })),
        maxUtf8Bytes: remainingBytes,
      });
    } catch {
      // Invalid or concurrently unreadable optional context cannot reject the admitted input.
      return null;
    }
    const admittedBySource = new Map(followAdmitted.map((entry) => [entry.observation.sourceSessionId, entry] as const));
    const followPrepared = [...budget.keptBySource.keys()].flatMap((sourceSessionId) => {
      const entry = admittedBySource.get(sourceSessionId);
      if (!entry) return [];
      const { observation, update, transcriptConsumedThroughByRenderedMessageCount, readMode } = entry;
      if (budget.omittedSources.includes(observation.sourceSessionId)) return [];
      const keptSeqs = budget.keptBySource.get(observation.sourceSessionId);
      const truncated = budget.truncatedBySource.get(observation.sourceSessionId) ?? update.truncated;
      const keptMessageCount = keptSeqs?.length ?? update.recentMessages.length;
      const consumedTranscriptSeq = readMode === 'initial_current_snapshot'
        ? observation.observed.transcriptSeq
        : transcriptConsumedThroughByRenderedMessageCount?.[keptMessageCount]
          ?? (keptSeqs && keptSeqs.length > 0
            ? keptSeqs[keptSeqs.length - 1]!
            : observation.delivered.transcriptSeq);
      const filtered = keptSeqs
        ? {
            ...update,
            recentMessages: update.recentMessages.filter((message) => keptSeqs.includes(message.seq)),
            observed: {
              ...update.observed,
              transcriptSeq: consumedTranscriptSeq,
            },
            truncated,
          }
        : (truncated !== update.truncated ? { ...update, truncated } : update);
      const ackable = filtered.reason !== 'source_unavailable'
        && (
          (observer.kind === 'account_voice' && observation.voiceExpected === null)
          || compareSessionFollowFrontierProgressV1(observation.delivered, filtered.observed) === 'ahead'
        );
      return [{ observation, update: filtered, workerUpdate: undefined as WorkerUpdateV1 | undefined, recheckWorkerUpdateAdmission: undefined, ackable }];
    });
    const prepared = [...workerPrepared, ...followPrepared];
    if (prepared.length === 0) return null;

    const wakeObservations = deliveryIntent === 'wake'
      ? normalizeSessionFollowWakeObservationsV1(prepared.map(({ observation, update }) => ({
          sourceSessionId: observation.sourceSessionId,
          ...(observation.edgeKind ? { edgeKind: observation.edgeKind, attachedAt: observation.attachedAt } : {}),
          expected: observation.delivered,
          consumed: update.observed,
        })))
      : undefined;
    const wakeEventLocalId = wakeObservations
      ? deriveSessionFollowWakeEventLocalIdV1({
          destinationSessionId,
          publisherGeneration,
          observations: wakeObservations,
        })
      : undefined;

    return {
      updates: followPrepared.map(({ update }) => update),
      ...(workerPrepared.length ? { workerUpdates: workerPrepared.map(({ workerUpdate }) => workerUpdate) } : {}),
      ...(deliveryIntent === 'wake' && workerPrepared.length ? {
        workerUpdateEvents: workerPrepared.map(({ observation, update, workerUpdate }) => ({
          localId: deriveSessionFollowWakeEventLocalIdV1({
            destinationSessionId, publisherGeneration,
            observations: [{ sourceSessionId: observation.sourceSessionId, edgeKind: 'reports_to',
              attachedAt: observation.attachedAt, expected: observation.delivered, consumed: update.observed }],
          }),
          update: workerUpdate,
        })),
      } : {}),
      ...(wakeEventLocalId ? { wakeEventLocalId } : {}),
      recheckAdmission: async (dispatchSignal) => {
        if (signal.aborted || dispatchSignal.aborted) return false;
        const current = await observeAdmission();
        if (signal.aborted || dispatchSignal.aborted) return false;
        // All or nothing: the wake event identity and its ACK name every represented
        // source, so a context that lost any of them is withdrawn rather than narrowed.
        const allowed = await Promise.all(prepared.map(async ({ observation, recheckWorkerUpdateAdmission }) =>
          isStillAdmitted(current, observation)
          && (!recheckWorkerUpdateAdmission || await recheckWorkerUpdateAdmission(dispatchSignal))));
        return !signal.aborted && !dispatchSignal.aborted && allowed.every(Boolean);
      },
      acknowledgeAccepted: (acceptance) => {
        if (
          acceptance.kind === 'context_only_wake'
          && acceptance.eventLocalId !== wakeEventLocalId
        ) return;
        const localInputId = acceptance.kind === 'context_only_wake'
          ? acceptance.eventLocalId
          : acceptance.localInputId;
        const userMessageSeq = acceptance.kind === 'context_only_wake' ? null : acceptance.userMessageSeq;
        if (signal.aborted) return;
        for (const { observation, update, ackable } of prepared) {
          if (!ackable) continue;
          const acknowledgement = observer.kind === 'account_voice'
            ? input.session.acknowledgeAccountVoiceFollow({
                executionRunId: executionRunId!,
                expectedExecutionRunOccurrenceId: observed.executionRunOccurrenceId!,
                sourceSessionId: observation.sourceSessionId,
                expectedPublisherGeneration: publisherGeneration,
                expected: observation.voiceExpected ?? null,
                observed: observation.observed,
                consumed: update.observed,
                acceptance: { localInputId, userMessageSeq },
              })
            : input.session.acknowledgeSessionFollow({
                sourceSessionId: observation.sourceSessionId,
                ...(observation.edgeKind ? { edgeKind: observation.edgeKind, attachedAt: observation.attachedAt } : {}),
                expectedPublisherGeneration: publisherGeneration,
                expected: observation.delivered,
                observed: observation.observed,
                consumed: update.observed,
                acceptance: acceptance.kind === 'context_only_wake'
                  ? { ...acceptance, observations: wakeObservations! }
                  : { kind: 'admitted_input', localInputId, userMessageSeq },
              });
          void acknowledgement.then((result: SessionFollowAcknowledgeResponseV1 | unknown) => {
            // A stale/revoked ACK is an ordinary reconciliation result. The next observation
            // will retain the source frontier; do not retry or invent a second receipt here.
            void result;
          }).catch(() => {
            // Provider acceptance already happened. Lost ACKs intentionally redeliver safely.
          });
        }
      },
    };
  };
}
