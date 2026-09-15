import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { normalizeEphemeralSendOutcome, type EphemeralSendOutcome } from '../ephemeralSendOutcome';
import { serializeOutboundError } from '../outboundErrorSerialization';

import type { ACPProvider } from '../sessionMessageTypes';
import {
  resolveCheckpointIntervalMs,
  resolveCheckpointMinChars,
  resolveInitialCheckpointDelayMs,
  resolveLiveCheckpointIntervalMs,
  resolveLiveSnapshotIntervalMs,
  resolveLiveSnapshotMinChars,
} from './env';
import { buildStreamedTranscriptSegmentKey, type StreamedTranscriptSegmentKey, type StreamedTranscriptSegmentKind } from './segmentKey';
import { commitStreamedTranscriptSegmentSnapshot } from './commitStreamedTranscriptSegmentSnapshot';
import {
  buildStreamedTranscriptSegmentDeltaBody,
  buildStreamedTranscriptSegmentSnapshotBody,
  buildStreamedTranscriptSegmentSnapshotMeta,
} from './buildStreamedTranscriptSegmentSnapshot';
import { normalizeSidechainId } from './normalizeSidechainId';
import { waitForSegmentDrain, type StreamedTranscriptSegmentRuntime, type StreamedTranscriptSegmentState } from './segmentRuntime';
import {
  acceptLivePublication,
  createLiveDeliveryState,
  disposeLiveDeliveryState,
  hasDirtyLiveDeliveryText,
  markLiveDeliveryRewrite,
  queueLiveDeliveryIntent,
  recordLiveDeliveryFailure,
  shouldPublishLiveDelta,
  takeLiveDeliveryRecoverySummary,
  takePendingLiveDeliveryIntent,
  type LiveDeliveryIntent,
} from './liveDeliveryState';
import type {
  StreamedTranscriptFlushSummary,
  StreamedTranscriptSegmentFlushSummary,
  StreamedTranscriptWriter,
  StreamedTranscriptWriterSession,
} from './types';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';

type SegmentKind = StreamedTranscriptSegmentKind;
type SegmentState = StreamedTranscriptSegmentState;

type SegmentKey = StreamedTranscriptSegmentKey;

type SegmentRuntime = StreamedTranscriptSegmentRuntime;

const DURABLE_COMMIT_FAILURE_RETRY_DELAY_MS = 2_000;

function didSegmentDurablyFlush(segment: SegmentRuntime, expectedState: SegmentState): boolean {
  return segment.lastCommittedTextVersion === segment.textVersion && segment.lastCommittedState === expectedState;
}

function buildFlushSummary(params: {
  flushedSegments: ReadonlyArray<SegmentRuntime>;
  expectedState: SegmentState;
  completeSegments?: ReadonlySet<SegmentRuntime>;
}): StreamedTranscriptFlushSummary {
  const segments: StreamedTranscriptSegmentFlushSummary[] = params.flushedSegments.map((segment) => ({
    kind: segment.kind,
    sidechainId: segment.sidechainId,
    localId: segment.segmentLocalId,
    sawText: segment.accumulatedText.length > 0,
    didDurablyFlush: didSegmentDurablyFlush(
      segment,
      params.completeSegments?.has(segment) ? 'complete' : params.expectedState,
    ),
    lastCommittedState: segment.lastCommittedState,
    commitResult: segment.lastCommitResult,
  }));

  const buildAggregate = (kind: SegmentKind, sidechainId?: string | null) => {
    const matches = segments.filter(
      (segment) => segment.kind === kind && segment.sawText && (sidechainId === undefined || segment.sidechainId === sidechainId),
    );
    return {
      sawText: matches.length > 0,
      didDurablyFlush: matches.length > 0 && matches.every((segment) => segment.didDurablyFlush),
    } as const;
  };

  return {
    assistant: buildAggregate('assistant'),
    assistantRoot: buildAggregate('assistant', null),
    thinking: buildAggregate('thinking'),
    thinkingRoot: buildAggregate('thinking', null),
    segments,
  };
}

export function createStreamedTranscriptWriter(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  makeLocalId?: () => string;
  initialCheckpointDelayMs?: number | null;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
  liveSnapshotIntervalMs?: number | null;
  liveSnapshotMinChars?: number | null;
  liveCheckpointIntervalMs?: number | null;
  durableCommitsRequireExplicitEnable?: boolean;
}): StreamedTranscriptWriter {
  const provider = params.provider;
  const session = params.session;
  const makeLocalId = typeof params.makeLocalId === 'function' ? params.makeLocalId : () => randomUUID();
  let durableCommitsEnabled = params.durableCommitsRequireExplicitEnable !== true;
  let commitProvenance: SessionTranscriptObservationProvenanceV1 | undefined;

  const initialCheckpointDelayMs = resolveInitialCheckpointDelayMs(params.initialCheckpointDelayMs);
  const checkpointIntervalMs = resolveCheckpointIntervalMs(params.checkpointIntervalMs);
  const checkpointMinChars = resolveCheckpointMinChars(params.checkpointMinChars);
  const liveSnapshotIntervalMs = resolveLiveSnapshotIntervalMs(params.liveSnapshotIntervalMs);
  const liveSnapshotMinChars = resolveLiveSnapshotMinChars(params.liveSnapshotMinChars);
  const liveCheckpointIntervalMs = resolveLiveCheckpointIntervalMs(params.liveCheckpointIntervalMs);

  const segments = new Map<SegmentKey, SegmentRuntime>();
  const toolBoundaryRewriteCandidates = new Map<SegmentKey, SegmentRuntime>();
  const inFlightToolBoundaryRewriteCandidates = new Set<SegmentRuntime>();
  const pendingRewriteRetries = new Set<SegmentRuntime>();
  let scheduleDurableCheckpoint: (segment: SegmentRuntime) => void;

  const clearLiveSnapshotTimer = (segment: SegmentRuntime) => {
    if (!segment.liveSnapshotTimer) return;
    clearTimeout(segment.liveSnapshotTimer);
    segment.liveSnapshotTimer = null;
  };

  const clearDurableCheckpointTimer = (segment: SegmentRuntime) => {
    if (!segment.durableCheckpointTimer) return;
    clearTimeout(segment.durableCheckpointTimer);
    segment.durableCheckpointTimer = null;
  };

  const commitDurableSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string; force?: boolean }) => {
    if (opts.state === 'streaming' && Date.now() < segment.durableRetryNotBeforeMs) {
      scheduleDurableCheckpoint(segment);
      return;
    }
    clearDurableCheckpointTimer(segment);
    if (!durableCommitsEnabled && opts.force !== true) return;
    commitStreamedTranscriptSegmentSnapshot({
      provider,
      session,
      segment,
      state: opts.state,
      interruptedReason: opts.interruptedReason,
      failureRetryDelayMs: DURABLE_COMMIT_FAILURE_RETRY_DELAY_MS,
      onStreamingCommitFailure: () => scheduleDurableCheckpoint(segment),
    });
  };

  const getOrCreateSegment = (
    kind: SegmentKind,
    sidechainId: string | null,
    exactLocalId?: string,
  ): SegmentRuntime => {
    const key = buildStreamedTranscriptSegmentKey(kind, sidechainId);
    const existing = segments.get(key);
    if (existing) {
      if (exactLocalId !== undefined) {
        if (existing.commitMode !== 'exact' || existing.segmentLocalId !== exactLocalId) {
          throw new Error(`Exact transcript segment identity mismatch for ${key}`);
        }
      } else if (existing.commitMode === 'exact') {
        throw new Error(`Exact transcript segment ${key} requires the exact append API`);
      }
      return existing;
    }

    const nowMs = Date.now();
    const created: SegmentRuntime = {
      key,
      kind,
      sidechainId,
      segmentLocalId: exactLocalId ?? makeLocalId(),
      commitMode: exactLocalId === undefined ? 'compatibility' : 'exact',
      startedAtMs: nowMs,
      accumulatedText: '',
      textVersion: 0,
      didWriteDurable: false,
      appendOnlySinceLastDurableSnapshot: true,
      lastDurableText: '',
      lastCheckpointAtMs: 0,
      lastCheckpointTextLen: 0,
      lastCommittedTextVersion: 0,
      lastCommittedState: null,
      lastCommitFailedAtMs: 0,
      lastCommitError: null,
      lastCommitResult: null,
      durableCommitFailure: null,
      durableRetryNotBeforeMs: 0,
      liveDelivery: createLiveDeliveryState(),
      additionalMeta: {},
      ...(commitProvenance ? { provenance: commitProvenance } : {}),
      durableCheckpointTimer: null,
      liveSnapshotTimer: null,
      isCommittingDurable: false,
      pendingDurableCommit: null,
      idleWaiters: [],
    };
    segments.set(key, created);
    return created;
  };

  const getExistingSegment = (kind: SegmentKind, sidechainId: string | null): SegmentRuntime | null => {
    const key = buildStreamedTranscriptSegmentKey(kind, sidechainId);
    return segments.get(key) ?? null;
  };

  const hasDirtyDurableText = (segment: SegmentRuntime) => {
    if (segment.appendOnlySinceLastDurableSnapshot) {
      return segment.accumulatedText.length !== segment.lastCheckpointTextLen;
    }
    return segment.accumulatedText !== segment.lastDurableText;
  };

  const getDirtyAppendChars = (segment: SegmentRuntime) => {
    if (segment.appendOnlySinceLastDurableSnapshot) {
      return segment.accumulatedText.length - segment.lastCheckpointTextLen;
    }
    if (!segment.accumulatedText.startsWith(segment.lastDurableText)) return checkpointMinChars;
    return segment.accumulatedText.length - segment.lastDurableText.length;
  };

  const commitScheduledDurableSnapshot = (segment: SegmentRuntime) => {
    if (!segments.has(segment.key)) return;
    if (!hasDirtyDurableText(segment)) return;
    commitDurableSnapshot(segment, { state: 'streaming' });
  };

  scheduleDurableCheckpoint = (segment: SegmentRuntime) => {
    if (!durableCommitsEnabled) {
      clearDurableCheckpointTimer(segment);
      return;
    }
    if (!hasDirtyDurableText(segment)) {
      clearDurableCheckpointTimer(segment);
      return;
    }
    if (segment.durableCheckpointTimer) return;

    const elapsedMs = segment.didWriteDurable ? Date.now() - segment.lastCheckpointAtMs : 0;
    const targetDelayMs = segment.didWriteDurable ? checkpointIntervalMs : initialCheckpointDelayMs;
    const cadenceDelayMs = targetDelayMs <= 0 ? 0 : Math.max(0, targetDelayMs - elapsedMs);
    const failureDelayMs = Math.max(0, segment.durableRetryNotBeforeMs - Date.now());
    const delayMs = Math.max(cadenceDelayMs, failureDelayMs);

    if (delayMs <= 0) {
      commitScheduledDurableSnapshot(segment);
      return;
    }

    const timer = setTimeout(() => {
      segment.durableCheckpointTimer = null;
      commitScheduledDurableSnapshot(segment);
    }, delayMs);
    timer.unref?.();
    segment.durableCheckpointTimer = timer;
  };

  const getLiveConnectionEpoch = (): number => {
    const epoch = session.getEphemeralStreamConnectionEpoch?.();
    return typeof epoch === 'number' && Number.isFinite(epoch) && epoch >= 0
      ? Math.trunc(epoch)
      : 0;
  };

  const logLiveFailure = (segment: SegmentRuntime, outcome: Extract<EphemeralSendOutcome, { accepted: false }>) => {
    const recorded = recordLiveDeliveryFailure({
      delivery: segment.liveDelivery,
      reason: outcome.reason,
      nowMs: Date.now(),
    });
    if (!recorded?.logFull) return;
    logger.debug('[StreamedTranscriptWriter] Live publication was not locally accepted (non-fatal)', {
      reason: outcome.reason,
      failureCount: recorded.count,
      localId: segment.segmentLocalId,
      kind: segment.kind,
      sidechainId: segment.sidechainId,
    });
  };

  const logUnresolvedLiveFailureSummary = (segment: SegmentRuntime): void => {
    const unresolved = takeLiveDeliveryRecoverySummary(segment.liveDelivery);
    if (!unresolved) return;
    logger.debug(
      '[StreamedTranscriptWriter] Live publication remained locally non-accepted at segment settlement',
      {
        failureCount: unresolved.count,
        suppressedFailureCount: unresolved.suppressedCount,
        firstReason: unresolved.firstReason,
        localId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      },
    );
  };

  const publishOneLiveIntent = async (segment: SegmentRuntime, intent: LiveDeliveryIntent): Promise<void> => {
    const nowMs = Date.now();
    const attemptedEpoch = getLiveConnectionEpoch();
    const accepted = segment.liveDelivery.locallyAccepted;
    const emitAsDelta = shouldPublishLiveDelta({
      delivery: segment.liveDelivery,
      state: intent.state,
      nowMs,
      epoch: attemptedEpoch,
      liveCheckpointIntervalMs,
      supportsDelta: typeof session.sendAgentMessageEphemeralDelta === 'function',
    });
    const text = segment.accumulatedText;
    const tick = (accepted?.tick ?? 0) + 1;
    const meta = buildStreamedTranscriptSegmentSnapshotMeta({
      segment,
      state: intent.state,
      interruptedReason: intent.interruptedReason,
      nowMs,
    });

    let outcome: EphemeralSendOutcome;
    try {
      const rawOutcome = emitAsDelta
        ? await session.sendAgentMessageEphemeralDelta?.(
          provider,
          buildStreamedTranscriptSegmentDeltaBody(segment, text.slice(accepted?.text.length ?? 0)),
          {
            localId: segment.segmentLocalId,
            tick,
            baseLength: accepted?.text.length ?? 0,
            meta,
            createdAt: segment.startedAtMs,
            updatedAt: nowMs,
          },
        )
        : await session.sendAgentMessageEphemeral?.(
          provider,
          buildStreamedTranscriptSegmentSnapshotBody(segment),
          {
            localId: segment.segmentLocalId,
            meta,
            tick,
            createdAt: segment.startedAtMs,
            updatedAt: nowMs,
          },
        );
      outcome = normalizeEphemeralSendOutcome(rawOutcome, attemptedEpoch);
    } catch (error) {
      outcome = {
        accepted: false,
        epoch: getLiveConnectionEpoch(),
        reason: { code: 'local_failure', error: serializeOutboundError(error) },
      };
    }

    if (!outcome.accepted) {
      logLiveFailure(segment, outcome);
      return;
    }

    const acceptedPublication = acceptLivePublication({
      delivery: segment.liveDelivery,
      text,
      tick,
      outcome,
      attemptedEpoch,
      acceptedAtMs: nowMs,
      wasCheckpoint: !emitAsDelta,
    });
    if (!acceptedPublication) {
      logLiveFailure(segment, {
        accepted: false,
        epoch: outcome.epoch,
        reason: { code: 'connection_epoch_changed' },
      });
      return;
    }

    const recovered = takeLiveDeliveryRecoverySummary(segment.liveDelivery);
    if (recovered) {
      logger.debug('[StreamedTranscriptWriter] Live publication recovered after local failures', {
        failureCount: recovered.count,
        suppressedFailureCount: recovered.suppressedCount,
        firstReason: recovered.firstReason,
        localId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      });
    }
  };

  const ensureLiveDeliveryDrain = (segment: SegmentRuntime): void => {
    if (segment.liveDelivery.disposed || segment.liveDelivery.inFlight || !segment.liveDelivery.pending) return;
    const drain = (async () => {
      let intent = takePendingLiveDeliveryIntent(segment.liveDelivery);
      while (intent) {
        await publishOneLiveIntent(segment, intent);
        intent = takePendingLiveDeliveryIntent(segment.liveDelivery);
      }
    })().catch((error) => {
      logLiveFailure(segment, {
        accepted: false,
        epoch: getLiveConnectionEpoch(),
        reason: { code: 'local_failure', error: serializeOutboundError(error) },
      });
    });
    segment.liveDelivery.inFlight = drain;
    void drain.then(() => {
      if (segment.liveDelivery.inFlight === drain) segment.liveDelivery.inFlight = null;
      ensureLiveDeliveryDrain(segment);
    });
  };

  const requestLivePublication = (segment: SegmentRuntime, intent: LiveDeliveryIntent): void => {
    if (typeof session.sendAgentMessageEphemeral !== 'function') return;
    clearLiveSnapshotTimer(segment);
    queueLiveDeliveryIntent(segment.liveDelivery, intent);
    ensureLiveDeliveryDrain(segment);
  };

  const waitForLiveDeliveryDrain = async (segment: SegmentRuntime): Promise<void> => {
    while (!segment.liveDelivery.disposed) {
      ensureLiveDeliveryDrain(segment);
      const current = segment.liveDelivery.inFlight;
      if (!current) return;
      await current;
    }
  };

  const scheduleLiveSnapshot = (segment: SegmentRuntime) => {
    if (typeof session.sendAgentMessageEphemeral !== 'function') return;
    if (segment.liveSnapshotTimer) return;
    if (!hasDirtyLiveDeliveryText(segment.liveDelivery, segment.accumulatedText)) return;

    const elapsedMs = Date.now() - (segment.liveDelivery.locallyAccepted?.acceptedAtMs ?? 0);
    const delayMs = liveSnapshotIntervalMs <= 0 ? 0 : Math.max(0, liveSnapshotIntervalMs - elapsedMs);
    const timer = setTimeout(() => {
      segment.liveSnapshotTimer = null;
      if (!segments.has(segment.key)) return;
      if (!hasDirtyLiveDeliveryText(segment.liveDelivery, segment.accumulatedText)) return;
      requestLivePublication(segment, { state: 'streaming' });
    }, delayMs);
    timer.unref?.();
    segment.liveSnapshotTimer = timer;
  };

  const maybeEmitLiveStreamingSnapshot = (segment: SegmentRuntime) => {
    if (typeof session.sendAgentMessageEphemeral !== 'function') return;

    const accepted = segment.liveDelivery.locallyAccepted;
    if (!accepted) {
      requestLivePublication(segment, { state: 'streaming' });
      return;
    }

    if (!hasDirtyLiveDeliveryText(segment.liveDelivery, segment.accumulatedText)) return;

    const isPureAppend = segment.liveDelivery.appendOnlySinceLocallyAccepted;
    const addedChars = isPureAppend
      ? segment.accumulatedText.length - accepted.text.length
      : liveSnapshotMinChars;
    const elapsedMs = Date.now() - accepted.acceptedAtMs;
    const shouldEmitImmediately = !isPureAppend
      ? true
      : liveSnapshotIntervalMs <= 0
        ? addedChars >= liveSnapshotMinChars
        : elapsedMs >= liveSnapshotIntervalMs && addedChars >= liveSnapshotMinChars;

    if (shouldEmitImmediately) {
      requestLivePublication(segment, { state: 'streaming' });
      return;
    }

    scheduleLiveSnapshot(segment);
  };

  const maybeCommitDurableStreamingSnapshot = (segment: SegmentRuntime) => {
    if (!durableCommitsEnabled) {
      clearDurableCheckpointTimer(segment);
      return;
    }
    if (!hasDirtyDurableText(segment)) {
      clearDurableCheckpointTimer(segment);
      return;
    }

    if (!segment.didWriteDurable) {
      if (typeof session.sendAgentMessageEphemeral !== 'function') {
        const addedChars = getDirtyAppendChars(segment);
        if (!segment.isCommittingDurable || (checkpointIntervalMs === 0 && addedChars >= checkpointMinChars)) {
          commitDurableSnapshot(segment, { state: 'streaming' });
        }
        return;
      }
      scheduleDurableCheckpoint(segment);
      return;
    }

    const addedChars = getDirtyAppendChars(segment);
    if (checkpointIntervalMs === 0) {
      if (addedChars >= checkpointMinChars) {
        commitDurableSnapshot(segment, { state: 'streaming' });
        return;
      }
      scheduleDurableCheckpoint(segment);
      return;
    }

    const elapsedMs = Date.now() - segment.lastCheckpointAtMs;
    if (elapsedMs >= checkpointIntervalMs && addedChars >= checkpointMinChars) {
      commitDurableSnapshot(segment, { state: 'streaming' });
      return;
    }

    scheduleDurableCheckpoint(segment);
  };

  const appendDelta = (
    kind: SegmentKind,
    deltaText: string,
    sidechainId: string | null,
    exactLocalId?: string,
  ) => {
    if (!deltaText) return;

    const segment = getOrCreateSegment(kind, sidechainId, exactLocalId);
    segment.accumulatedText += deltaText;
    segment.textVersion += 1;
    maybeEmitLiveStreamingSnapshot(segment);
    maybeCommitDurableStreamingSnapshot(segment);
  };

  const overrideSegmentText = (kind: SegmentKind, text: string, sidechainId: string | null): boolean => {
    const key = buildStreamedTranscriptSegmentKey(kind, sidechainId);
    const segment = segments.get(key);
    if (!segment) {
      const rewriteCandidate = toolBoundaryRewriteCandidates.get(key);
      if (!rewriteCandidate) return false;
      if (rewriteCandidate.accumulatedText === text) return true;
      rewriteCandidate.accumulatedText = text;
      rewriteCandidate.appendOnlySinceLastDurableSnapshot = false;
      rewriteCandidate.textVersion += 1;
      commitDurableSnapshot(rewriteCandidate, { state: 'complete', force: true });
      return true;
    }
    if (segment.accumulatedText === text) return true;
    segment.accumulatedText = text;
    segment.appendOnlySinceLastDurableSnapshot = false;
    markLiveDeliveryRewrite(segment.liveDelivery);
    segment.textVersion += 1;
    maybeEmitLiveStreamingSnapshot(segment);
    maybeCommitDurableStreamingSnapshot(segment);
    return true;
  };

  const mergeSegmentMeta = (kind: SegmentKind, meta: Record<string, unknown>, sidechainId: string | null): boolean => {
    const segment = getExistingSegment(kind, sidechainId);
    if (!segment) return false;
    segment.additionalMeta = {
      ...segment.additionalMeta,
      ...meta,
    };
    return true;
  };

  const updateToolBoundaryRewriteCandidates = (
    reason: 'tool-call-boundary' | 'turn-end' | 'abort',
    flushedSegments: ReadonlyArray<SegmentRuntime>,
  ): SegmentRuntime[] => {
    const candidatesToDrain = reason === 'tool-call-boundary'
      ? []
      : Array.from(new Set([
          ...toolBoundaryRewriteCandidates.values(),
          ...inFlightToolBoundaryRewriteCandidates,
        ]));
    if (reason === 'tool-call-boundary') {
      for (const segment of flushedSegments) {
        if (segment.accumulatedText.length > 0) {
          toolBoundaryRewriteCandidates.set(segment.key, segment);
          inFlightToolBoundaryRewriteCandidates.add(segment);
        }
      }
    } else {
      toolBoundaryRewriteCandidates.clear();
    }
    return candidatesToDrain;
  };

  const flushAll = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }): Promise<StreamedTranscriptFlushSummary> => {
    const state: SegmentState = opts.reason === 'abort' ? 'interrupted' : 'complete';
    const drainPromises: Promise<void>[] = [];
    const flushedSegments = Array.from(segments.values());
    const rewriteCandidatesToDrain = Array.from(new Set([
      ...pendingRewriteRetries,
      ...updateToolBoundaryRewriteCandidates(opts.reason, flushedSegments),
    ]));
    pendingRewriteRetries.clear();
    const rewriteCandidateSet = new Set(rewriteCandidatesToDrain);

    for (const segment of rewriteCandidatesToDrain) {
      if (!segment.isCommittingDurable && !didSegmentDurablyFlush(segment, 'complete')) {
        commitDurableSnapshot(segment, { state: 'complete', force: true });
      }
    }

    for (const segment of flushedSegments) {
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      requestLivePublication(segment, { state, interruptedReason: opts.interruptedReason });
      segments.delete(segment.key);
      drainPromises.push((async () => {
        // The durable snapshot replaces the live projection for this localId.
        // Settle every queued live publication first so a delayed ephemeral
        // delivery cannot temporarily overwrite the terminal durable state.
        await waitForLiveDeliveryDrain(segment);
        commitDurableSnapshot(segment, { state, interruptedReason: opts.interruptedReason, force: true });
        await waitForSegmentDrain(segment);
      })());
    }

    await Promise.all([
      ...drainPromises,
      ...rewriteCandidatesToDrain.map((segment) => waitForSegmentDrain(segment)),
    ]);
    const settledSegments = Array.from(new Set([
      ...flushedSegments,
      ...rewriteCandidatesToDrain,
    ]));
    for (const segment of settledSegments) {
      const isRewriteCandidate = rewriteCandidateSet.has(segment)
        || inFlightToolBoundaryRewriteCandidates.has(segment)
        || toolBoundaryRewriteCandidates.get(segment.key) === segment;
      const expectedState = isRewriteCandidate ? 'complete' : state;
      if (
        segment.commitMode === 'compatibility'
        && (segment.lastCommitError !== null || !didSegmentDurablyFlush(segment, expectedState))
      ) {
        if (isRewriteCandidate) {
          pendingRewriteRetries.add(segment);
        } else {
          segments.set(segment.key, segment);
        }
      }
    }
    if (opts.reason === 'tool-call-boundary') {
      for (const segment of flushedSegments) {
        inFlightToolBoundaryRewriteCandidates.delete(segment);
      }
    }
    const failedExactSegment = settledSegments.find((segment) =>
      segment.commitMode === 'exact'
      && (
        segment.lastCommitError !== null
        || !didSegmentDurablyFlush(segment, rewriteCandidateSet.has(segment) ? 'complete' : state)
      ),
    );
    if (failedExactSegment) {
      const reason = failedExactSegment.lastCommitError instanceof Error
        ? failedExactSegment.lastCommitError.message
        : 'durable acknowledgement was not received';
      throw new Error(`Exact transcript segment commit failed for ${failedExactSegment.segmentLocalId}: ${reason}`);
    }
    for (const segment of settledSegments) logUnresolvedLiveFailureSummary(segment);
    return buildFlushSummary({
      flushedSegments: settledSegments,
      expectedState: state,
      completeSegments: rewriteCandidateSet,
    });
  };

  const flushAllThroughDurableAdmission = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }): Promise<void> => {
    const state: SegmentState = opts.reason === 'abort' ? 'interrupted' : 'complete';
    const flushedSegments = Array.from(segments.values());
    for (const segment of updateToolBoundaryRewriteCandidates(opts.reason, flushedSegments)) {
      pendingRewriteRetries.add(segment);
    }

    await Promise.all(flushedSegments.map(async (segment) => {
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      requestLivePublication(segment, { state, interruptedReason: opts.interruptedReason });
      segments.delete(segment.key);
      // Preserve the live-before-durable ordering contract, but release the provider
      // event queue as soon as the durable write has been admitted to the session's
      // serialized commit queue. Network/server ACK settlement remains observable in
      // the writer's existing background completion path.
      await waitForLiveDeliveryDrain(segment);
      commitStreamedTranscriptSegmentSnapshot({
        provider,
        session,
        segment,
        state,
        interruptedReason: opts.interruptedReason,
        admissionOnly: true,
      });
      logUnresolvedLiveFailureSummary(segment);
    }));
  };

  const enableDurableCommits = () => {
    if (durableCommitsEnabled) return;
    durableCommitsEnabled = true;
    for (const segment of segments.values()) {
      maybeCommitDurableStreamingSnapshot(segment);
    }
  };

  const discard = () => {
    for (const segment of segments.values()) {
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      logUnresolvedLiveFailureSummary(segment);
      disposeLiveDeliveryState(segment.liveDelivery);
      segment.pendingDurableCommit = null;
      segment.idleWaiters.splice(0, segment.idleWaiters.length).forEach((resolve) => resolve());
    }
    segments.clear();
    toolBoundaryRewriteCandidates.clear();
    inFlightToolBoundaryRewriteCandidates.clear();
    pendingRewriteRetries.clear();
  };

  return {
    appendAssistantDelta: (deltaText, opts) => appendDelta('assistant', deltaText, normalizeSidechainId(opts?.sidechainId)),
    appendAssistantDeltaExact: (deltaText, opts) => {
      const localId = readNonBlankOpaqueIdentifier(opts?.localId);
      if (!localId) {
        throw new Error('Exact assistant transcript append requires a caller-supplied non-blank localId');
      }
      appendDelta('assistant', deltaText, normalizeSidechainId(opts?.sidechainId), localId);
    },
    appendThinkingDelta: (deltaText, opts) => appendDelta('thinking', deltaText, normalizeSidechainId(opts?.sidechainId)),
    overrideAssistantText: (text, opts) => overrideSegmentText('assistant', text, normalizeSidechainId(opts?.sidechainId)),
    overrideThinkingText: (text, opts) => overrideSegmentText('thinking', text, normalizeSidechainId(opts?.sidechainId)),
    mergeAssistantMeta: (meta, opts) => mergeSegmentMeta('assistant', meta, normalizeSidechainId(opts?.sidechainId)),
    setCommitProvenance: (provenance) => {
      commitProvenance = provenance ?? undefined;
    },
    enableDurableCommits,
    discard,
    flushAll,
    flushAllThroughDurableAdmission,
  };
}
