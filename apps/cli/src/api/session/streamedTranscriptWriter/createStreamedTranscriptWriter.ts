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
  if (segment.accumulatedText.length === 0) return false;
  return segment.lastCommittedTextVersion === segment.textVersion && segment.lastCommittedState === expectedState;
}

function buildFlushSummary(params: {
  flushedSegments: ReadonlyArray<SegmentRuntime>;
  expectedState: (segment: SegmentRuntime) => SegmentState;
}): StreamedTranscriptFlushSummary {
  const segments: StreamedTranscriptSegmentFlushSummary[] = params.flushedSegments.map((segment) => ({
    kind: segment.kind,
    sidechainId: segment.sidechainId,
    localId: segment.segmentLocalId,
    sawText: segment.accumulatedText.length > 0,
    didDurablyFlush: didSegmentDurablyFlush(segment, params.expectedState(segment)),
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
  // Closed segments retain their identity and terminal intent until persistence
  // succeeds. They cannot become the append target for a later reply.
  const terminalSegments = new Map<SegmentRuntime, {
    state: SegmentState;
    interruptedReason?: string;
    drain: Promise<void> | null;
    failureReported: boolean;
    retryAfterDrain: boolean;
  }>();
  let unsubscribeConnectionState: (() => void) | null = null;
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
    if (segments.get(segment.key) !== segment) return;
    if (!hasDirtyDurableText(segment)) return;
    commitDurableSnapshot(segment, { state: 'streaming' });
  };

  scheduleDurableCheckpoint = (segment: SegmentRuntime) => {
    if (segments.get(segment.key) !== segment) return;
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
    const segment = getExistingSegment(kind, sidechainId);
    if (!segment) return false;
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

  const closeSegments = (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }) => {
    for (const segment of segments.values()) {
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      terminalSegments.set(segment, {
        state: opts.reason === 'abort' ? 'interrupted' : 'complete',
        interruptedReason: opts.interruptedReason,
        drain: null,
        failureReported: false,
        retryAfterDrain: false,
      });
    }
    segments.clear();
    if (terminalSegments.size > 0 && !unsubscribeConnectionState) {
      unsubscribeConnectionState = session.subscribeToSessionConnectionState?.((state) => {
        if (state.phase !== 'online') return;
        for (const [segment, terminal] of terminalSegments) {
          // A reconnect can arrive before an offline write has settled. Preserve
          // that wake until the original attempt releases its drain.
          if (terminal.drain) terminal.retryAfterDrain = true;
          else startTerminalCommit(segment, terminal, false);
        }
      }) ?? null;
    }
    return Array.from(terminalSegments.entries());
  };

  const startTerminalCommit = (
    segment: SegmentRuntime,
    terminal: NonNullable<ReturnType<typeof terminalSegments.get>>,
    admissionOnly: boolean,
  ) => {
    if (terminal.drain) return;
    terminal.drain = (async () => {
      requestLivePublication(segment, { state: terminal.state, interruptedReason: terminal.interruptedReason });
      await waitForLiveDeliveryDrain(segment);
      const commit = commitStreamedTranscriptSegmentSnapshot({
        provider,
        session,
        segment,
        state: terminal.state,
        interruptedReason: terminal.interruptedReason,
        admissionOnly,
      });
      // Admission does not wait for an earlier checkpoint ACK, but still owns
      // and observes its terminal write. Ordinary flushes drain both writes.
      if (admissionOnly) await commit;
      await waitForSegmentDrain(segment);
      if (didSegmentDurablyFlush(segment, terminal.state)) {
        terminalSegments.delete(segment);
      } else if (!terminal.failureReported) {
        terminal.failureReported = true;
        logger.infoFile('[StreamedTranscriptWriter] Terminal snapshot delivery unresolved; retained for retry', {
          localId: segment.segmentLocalId,
          kind: segment.kind,
          sidechainId: segment.sidechainId,
          state: terminal.state,
          textLength: segment.accumulatedText.length,
        });
      }
      logUnresolvedLiveFailureSummary(segment);
    })().finally(() => {
      terminal.drain = null;
      if (terminal.retryAfterDrain && terminalSegments.has(segment)) {
        terminal.retryAfterDrain = false;
        startTerminalCommit(segment, terminal, false);
      }
      if (terminalSegments.size === 0) {
        unsubscribeConnectionState?.();
        unsubscribeConnectionState = null;
      }
    });
  };

  const flushAll = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }): Promise<StreamedTranscriptFlushSummary> => {
    const entries = closeSegments(opts);
    for (const [segment, terminal] of entries) startTerminalCommit(segment, terminal, false);
    await Promise.all(entries.map(([, terminal]) => terminal.drain));
    const failedExactSegment = entries.find(([segment, terminal]) =>
      segment.commitMode === 'exact' && !didSegmentDurablyFlush(segment, terminal.state),
    )?.[0];
    if (failedExactSegment) {
      const reason = failedExactSegment.lastCommitError instanceof Error
        ? failedExactSegment.lastCommitError.message
        : 'durable acknowledgement was not received';
      throw new Error(`Exact transcript segment commit failed for ${failedExactSegment.segmentLocalId}: ${reason}`);
    }
    const terminalBySegment = new Map(entries);
    return buildFlushSummary({
      flushedSegments: entries.map(([segment]) => segment),
      expectedState: (segment) => terminalBySegment.get(segment)!.state,
    });
  };

  const flushAllThroughDurableAdmission = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }): Promise<void> => {
    const entries = closeSegments(opts);
    for (const [segment, terminal] of entries) startTerminalCommit(segment, terminal, true);
    // Each task enters the session-owned commit queue after live delivery drains;
    // waiting only on that live drain preserves tool-event admission ordering.
    await Promise.all(entries.map(([segment]) => waitForLiveDeliveryDrain(segment)));
  };

  const enableDurableCommits = () => {
    if (durableCommitsEnabled) return;
    durableCommitsEnabled = true;
    for (const segment of segments.values()) {
      maybeCommitDurableStreamingSnapshot(segment);
    }
  };

  const discard = () => {
    unsubscribeConnectionState?.();
    unsubscribeConnectionState = null;
    for (const segment of [...segments.values(), ...terminalSegments.keys()]) {
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      logUnresolvedLiveFailureSummary(segment);
      disposeLiveDeliveryState(segment.liveDelivery);
      segment.pendingDurableCommit = null;
      segment.idleWaiters.splice(0, segment.idleWaiters.length).forEach((resolve) => resolve());
    }
    segments.clear();
    terminalSegments.clear();
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
    hasPendingSegments: () => segments.size > 0 || terminalSegments.size > 0,
    flushAll,
    flushAllThroughDurableAdmission,
  };
}
