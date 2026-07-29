import { randomUUID } from 'node:crypto';

import { logger } from '../../../ui/logger';
import {
  createEphemeralSendFailure,
  normalizeEphemeralSendOutcome,
  type EphemeralSendOutcome,
} from '../client/transcript/ephemeralSendOutcome';

import type { ACPProvider } from '../sessionMessageTypes';
import {
  resolveInitialCheckpointDelayMs,
  resolveCheckpointIntervalMs,
  resolveCheckpointMinChars,
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
  markLiveDeliveryFailure,
  markLiveDeliveryRewrite,
  queueLiveDeliveryIntent,
  shouldPublishLiveDelta,
  takeLiveDeliveryFailureSummary,
  takePendingLiveDeliveryIntent,
  type LiveDeliveryIntent,
} from './liveDeliveryState';
import type {
  StreamedTranscriptFlushSummary,
  StreamedTranscriptSegmentFlushSummary,
  StreamedTranscriptWriter,
  StreamedTranscriptWriterSession,
} from './types';

type SegmentKind = StreamedTranscriptSegmentKind;
type SegmentState = StreamedTranscriptSegmentState;

type SegmentKey = StreamedTranscriptSegmentKey;

type SegmentRuntime = StreamedTranscriptSegmentRuntime;

function didSegmentDurablyFlush(segment: SegmentRuntime, expectedState: SegmentState): boolean {
  if (segment.accumulatedText.length === 0) return false;
  return segment.lastCommittedTextVersion === segment.textVersion && segment.lastCommittedState === expectedState;
}

function buildFlushSummary(params: {
  flushedSegments: ReadonlyArray<SegmentRuntime>;
  expectedState: SegmentState;
}): StreamedTranscriptFlushSummary {
  const segments: StreamedTranscriptSegmentFlushSummary[] = params.flushedSegments.map((segment) => ({
    kind: segment.kind,
    sidechainId: segment.sidechainId,
    sawText: segment.accumulatedText.length > 0,
    didDurablyFlush: didSegmentDurablyFlush(segment, params.expectedState),
    lastCommittedState: segment.lastCommittedState,
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

  const initialCheckpointDelayMs = resolveInitialCheckpointDelayMs(params.initialCheckpointDelayMs);
  const checkpointIntervalMs = resolveCheckpointIntervalMs(params.checkpointIntervalMs);
  const checkpointMinChars = resolveCheckpointMinChars(params.checkpointMinChars);
  const liveSnapshotIntervalMs = resolveLiveSnapshotIntervalMs(params.liveSnapshotIntervalMs);
  const liveSnapshotMinChars = resolveLiveSnapshotMinChars(params.liveSnapshotMinChars);
  const liveCheckpointIntervalMs = resolveLiveCheckpointIntervalMs(params.liveCheckpointIntervalMs);

  const segments = new Set<SegmentRuntime>();

  const findAppendableSegment = (key: SegmentKey): SegmentRuntime | null => {
    for (const segment of segments) {
      if (segment.key === key && !segment.isTerminalizing) return segment;
    }
    return null;
  };

  const commitDurableSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string; force?: boolean }) => {
    clearDurableCheckpointTimer(segment);
    if (!durableCommitsEnabled && opts.force !== true) return;
    commitStreamedTranscriptSegmentSnapshot({
      provider,
      session,
      segment,
      state: opts.state,
      interruptedReason: opts.interruptedReason,
    });
  };

  const getOrCreateSegment = (kind: SegmentKind, sidechainId: string | null): SegmentRuntime => {
    const key = buildStreamedTranscriptSegmentKey(kind, sidechainId);
    const existing = findAppendableSegment(key);
    if (existing) return existing;

    const nowMs = Date.now();
    const created: SegmentRuntime = {
      key,
      kind,
      sidechainId,
      segmentLocalId: makeLocalId(),
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
      liveDelivery: createLiveDeliveryState(),
      durableCheckpointTimer: null,
      liveSnapshotTimer: null,
      isTerminalizing: false,
      isCommittingDurable: false,
      pendingDurableCommit: null,
      idleWaiters: [],
    };
    segments.add(created);
    return created;
  };

  const getExistingSegment = (kind: SegmentKind, sidechainId: string | null): SegmentRuntime | null => {
    const key = buildStreamedTranscriptSegmentKey(kind, sidechainId);
    return findAppendableSegment(key);
  };

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
    if (!segments.has(segment)) return;
    if (!hasDirtyDurableText(segment)) return;
    commitDurableSnapshot(segment, { state: 'streaming' });
  };

  const scheduleDurableCheckpoint = (segment: SegmentRuntime) => {
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
    const delayMs = targetDelayMs <= 0 ? 0 : Math.max(0, targetDelayMs - elapsedMs);

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
    return typeof epoch === 'number' && Number.isFinite(epoch) && epoch >= 0 ? Math.trunc(epoch) : 0;
  };

  const recordLiveFailure = (segment: SegmentRuntime, outcome: Extract<EphemeralSendOutcome, { accepted: false }>): void => {
    const isFirst = markLiveDeliveryFailure(segment.liveDelivery, outcome);
    if (!isFirst) return;
    logger.debug('[StreamedTranscriptWriter] Live publication was not locally accepted (non-fatal)', {
      reason: outcome.reason,
      error: outcome.error,
      localId: segment.segmentLocalId,
      kind: segment.kind,
      sidechainId: segment.sidechainId,
    });
  };

  const publishOneLiveIntent = async (segment: SegmentRuntime, intent: LiveDeliveryIntent): Promise<void> => {
    const sendSnapshot = session.sendAgentMessageEphemeral;
    if (typeof sendSnapshot !== 'function') return;

    const nowMs = Date.now();
    const attemptedEpoch = getLiveConnectionEpoch();
    const accepted = segment.liveDelivery.locallyAccepted;
    const emitAsDelta = shouldPublishLiveDelta(segment.liveDelivery, {
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
      const raw = emitAsDelta
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
        : await sendSnapshot(
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
      outcome = normalizeEphemeralSendOutcome(raw, attemptedEpoch);
    } catch (error) {
      outcome = createEphemeralSendFailure('emit_failed', getLiveConnectionEpoch(), error);
    }

    if (!outcome.accepted) {
      recordLiveFailure(segment, outcome);
      return;
    }
    if (outcome.epoch !== attemptedEpoch) {
      recordLiveFailure(segment, createEphemeralSendFailure('connection_epoch_changed', outcome.epoch));
      return;
    }

    acceptLivePublication(segment.liveDelivery, {
      text,
      tick,
      epoch: outcome.epoch,
      acceptedAtMs: nowMs,
      wasCheckpoint: !emitAsDelta,
    });
    const recovered = takeLiveDeliveryFailureSummary(segment.liveDelivery);
    if (recovered) {
      logger.debug('[StreamedTranscriptWriter] Live publication recovered after local failures', {
        failureCount: recovered.count,
        firstFailure: recovered.firstFailure,
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
      recordLiveFailure(segment, createEphemeralSendFailure('emit_failed', getLiveConnectionEpoch(), error));
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
    if (segment.liveSnapshotTimer || !hasDirtyLiveDeliveryText(segment.liveDelivery, segment.accumulatedText)) return;

    const elapsedMs = Date.now() - (segment.liveDelivery.locallyAccepted?.acceptedAtMs ?? 0);
    const delayMs = liveSnapshotIntervalMs <= 0 ? 0 : Math.max(0, liveSnapshotIntervalMs - elapsedMs);
    const timer = setTimeout(() => {
      segment.liveSnapshotTimer = null;
      if (!segments.has(segment)) return;
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
    const addedChars = isPureAppend ? segment.accumulatedText.length - accepted.text.length : liveSnapshotMinChars;
    const elapsedMs = Date.now() - accepted.acceptedAtMs;
    const shouldEmitImmediately = !isPureAppend
      || (liveSnapshotIntervalMs <= 0
        ? addedChars >= liveSnapshotMinChars
        : elapsedMs >= liveSnapshotIntervalMs && addedChars >= liveSnapshotMinChars);

    if (shouldEmitImmediately) requestLivePublication(segment, { state: 'streaming' });
    else scheduleLiveSnapshot(segment);
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
        if (!segment.isCommittingDurable) {
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

  const appendDelta = (kind: SegmentKind, deltaText: string, sidechainId: string | null) => {
    if (!deltaText) return;

    const segment = getOrCreateSegment(kind, sidechainId);
    segment.accumulatedText += deltaText;
    segment.textVersion += 1;
    if (kind === 'assistant' && sidechainId === null) {
      session.turnAssistantTextSnapshotStore?.observe({
        text: segment.accumulatedText,
        provider,
        localId: segment.segmentLocalId,
        sidechainId,
        source: 'streaming',
      });
    }
    maybeEmitLiveStreamingSnapshot(segment);
    maybeCommitDurableStreamingSnapshot(segment);
  };

  const overrideSegmentText = (kind: SegmentKind, text: string, sidechainId: string | null): boolean => {
    const segment = getExistingSegment(kind, sidechainId);
    if (!segment) return false;
    if (segment.accumulatedText === text) return true;
    segment.accumulatedText = text;
    segment.textVersion += 1;
    segment.appendOnlySinceLastDurableSnapshot = false;
    markLiveDeliveryRewrite(segment.liveDelivery);
    if (kind === 'assistant' && sidechainId === null) {
      session.turnAssistantTextSnapshotStore?.observe({
        text: segment.accumulatedText,
        provider,
        localId: segment.segmentLocalId,
        sidechainId,
        source: 'streaming',
      });
    }
    maybeEmitLiveStreamingSnapshot(segment);
    maybeCommitDurableStreamingSnapshot(segment);
    return true;
  };

  const flushAll = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }): Promise<StreamedTranscriptFlushSummary> => {
    const state: SegmentState = opts.reason === 'abort' ? 'interrupted' : 'complete';
    const drainPromises: Promise<void>[] = [];
    const flushedSegments = Array.from(segments);

    for (const segment of flushedSegments) {
      segment.isTerminalizing = true;
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      requestLivePublication(segment, { state, interruptedReason: opts.interruptedReason });
      drainPromises.push((async () => {
        // A delayed ephemeral completion must settle before the same-localId durable terminal row.
        await waitForLiveDeliveryDrain(segment);
        while (segment.isCommittingDurable || segment.pendingDurableCommit) {
          await waitForSegmentDrain(segment);
        }
        if (!didSegmentDurablyFlush(segment, state)) {
          commitDurableSnapshot(segment, { state, interruptedReason: opts.interruptedReason, force: true });
          await waitForSegmentDrain(segment);
        }
        if (
          segments.has(segment)
          && didSegmentDurablyFlush(segment, state)
        ) {
          segments.delete(segment);
        }
      })());
    }

    await Promise.all(drainPromises);
    return buildFlushSummary({ flushedSegments, expectedState: state });
  };

  const enableDurableCommits = () => {
    if (durableCommitsEnabled) return;
    durableCommitsEnabled = true;
    for (const segment of segments) {
      if (segment.isTerminalizing) continue;
      maybeCommitDurableStreamingSnapshot(segment);
    }
  };

  const discard = () => {
    for (const segment of segments) {
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      disposeLiveDeliveryState(segment.liveDelivery);
      segment.pendingDurableCommit = null;
      const currentSnapshot = session.turnAssistantTextSnapshotStore?.getCurrentTurnSnapshot();
      if (currentSnapshot?.localId === segment.segmentLocalId) {
        session.turnAssistantTextSnapshotStore?.clearSnapshot({ reason: 'clear' });
      }
      segment.idleWaiters.splice(0, segment.idleWaiters.length).forEach((resolve) => resolve());
    }
    segments.clear();
  };

  return {
    appendAssistantDelta: (deltaText, opts) => appendDelta('assistant', deltaText, normalizeSidechainId(opts?.sidechainId)),
    appendThinkingDelta: (deltaText, opts) => appendDelta('thinking', deltaText, normalizeSidechainId(opts?.sidechainId)),
    overrideAssistantText: (text, opts) => overrideSegmentText('assistant', text, normalizeSidechainId(opts?.sidechainId)),
    overrideThinkingText: (text, opts) => overrideSegmentText('thinking', text, normalizeSidechainId(opts?.sidechainId)),
    enableDurableCommits,
    discard,
    flushAll,
  };
}
