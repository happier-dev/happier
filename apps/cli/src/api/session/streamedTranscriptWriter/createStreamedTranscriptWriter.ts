import { randomUUID } from 'node:crypto';

import { logger } from '../../../ui/logger';

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

  const segments = new Map<SegmentKey, SegmentRuntime>();

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
    const existing = segments.get(key);
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
      didWriteLive: false,
      appendOnlySinceLastDurableSnapshot: true,
      appendOnlySinceLastLiveSnapshot: true,
      lastDurableText: '',
      lastCheckpointAtMs: 0,
      lastCheckpointTextLen: 0,
      lastCommittedTextVersion: 0,
      lastCommittedState: null,
      lastCommitFailedAtMs: 0,
      lastLiveSnapshotAtMs: 0,
      lastLiveSnapshotTextLen: 0,
      lastLiveSnapshotText: '',
      liveTick: 0,
      lastLiveCheckpointAtMs: 0,
      lastLiveEmitEpoch: null,
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
    if (!segments.has(segment.key)) return;
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

  const shouldEmitLiveDelta = (segment: SegmentRuntime, opts: { state: SegmentState; nowMs: number; epoch: number | null }): boolean => {
    if (typeof session.sendAgentMessageEphemeralDelta !== 'function') return false;
    // 0 disables deltas entirely: every live emission is a full snapshot (pre-delta behavior).
    if (liveCheckpointIntervalMs <= 0) return false;
    // Segment state transitions (complete/interrupted) always resync receivers with a snapshot.
    if (opts.state !== 'streaming') return false;
    // The first live emission for a segment establishes receiver assembly state.
    if (!segment.didWriteLive) return false;
    // Deltas only describe pure appends; rewrites need a full snapshot.
    if (!segment.appendOnlySinceLastLiveSnapshot) return false;
    // Periodic full-snapshot checkpoint so receivers can recover from dropped deltas.
    if (opts.nowMs - segment.lastLiveCheckpointAtMs >= liveCheckpointIntervalMs) return false;
    // After a transport reconnect, resync with a full snapshot first.
    if (opts.epoch !== null && segment.lastLiveEmitEpoch !== null && opts.epoch !== segment.lastLiveEmitEpoch) return false;
    return true;
  };

  const emitLiveSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string }) => {
    const sendLiveSnapshot = session.sendAgentMessageEphemeral;
    if (typeof sendLiveSnapshot !== 'function') return;

    clearLiveSnapshotTimer(segment);

    const nowMs = Date.now();
    const epoch = typeof session.getEphemeralStreamConnectionEpoch === 'function'
      ? session.getEphemeralStreamConnectionEpoch()
      : null;
    const sendDelta = session.sendAgentMessageEphemeralDelta;
    const emitAsDelta = typeof sendDelta === 'function' && shouldEmitLiveDelta(segment, { state: opts.state, nowMs, epoch });
    const meta = buildStreamedTranscriptSegmentSnapshotMeta({
      segment,
      state: opts.state,
      interruptedReason: opts.interruptedReason,
      nowMs,
    });
    const tick = segment.liveTick + 1;

    try {
      if (emitAsDelta) {
        const deltaText = segment.accumulatedText.slice(segment.lastLiveSnapshotTextLen);
        void Promise.resolve(
          sendDelta(provider, buildStreamedTranscriptSegmentDeltaBody(segment, deltaText), {
            localId: segment.segmentLocalId,
            tick,
            baseLength: segment.lastLiveSnapshotTextLen,
            meta,
            createdAt: segment.startedAtMs,
            updatedAt: nowMs,
          }),
        ).catch((error) => {
          logger.debug('[StreamedTranscriptWriter] Live delta emit failed (non-fatal)', {
            error,
            localId: segment.segmentLocalId,
            kind: segment.kind,
            sidechainId: segment.sidechainId,
          });
        });
      } else {
        const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
        void Promise.resolve(
          sendLiveSnapshot(provider, body, {
            localId: segment.segmentLocalId,
            meta,
            tick,
            createdAt: segment.startedAtMs,
            updatedAt: nowMs,
          }),
        ).catch((error) => {
          logger.debug('[StreamedTranscriptWriter] Live snapshot emit failed (non-fatal)', {
            error,
            localId: segment.segmentLocalId,
            kind: segment.kind,
            sidechainId: segment.sidechainId,
          });
        });
        segment.lastLiveCheckpointAtMs = nowMs;
      }
    } catch (error) {
      logger.debug('[StreamedTranscriptWriter] Live snapshot emit failed synchronously (non-fatal)', {
        error,
        localId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      });
    }

    segment.liveTick = tick;
    segment.lastLiveEmitEpoch = epoch;
    segment.didWriteLive = true;
    segment.lastLiveSnapshotAtMs = nowMs;
    segment.lastLiveSnapshotTextLen = segment.accumulatedText.length;
    segment.lastLiveSnapshotText = segment.accumulatedText;
    segment.appendOnlySinceLastLiveSnapshot = true;
  };

  const hasDirtyLiveSnapshotText = (segment: SegmentRuntime) => {
    if (segment.appendOnlySinceLastLiveSnapshot) {
      return segment.accumulatedText.length !== segment.lastLiveSnapshotTextLen;
    }
    return segment.accumulatedText !== segment.lastLiveSnapshotText;
  };

  const scheduleLiveSnapshot = (segment: SegmentRuntime) => {
    if (typeof session.sendAgentMessageEphemeral !== 'function') return;
    if (segment.liveSnapshotTimer) return;
    if (!hasDirtyLiveSnapshotText(segment)) return;

    const elapsedMs = Date.now() - segment.lastLiveSnapshotAtMs;
    const delayMs = liveSnapshotIntervalMs <= 0 ? 0 : Math.max(0, liveSnapshotIntervalMs - elapsedMs);
    const timer = setTimeout(() => {
      segment.liveSnapshotTimer = null;
      if (!segments.has(segment.key)) return;
      if (!hasDirtyLiveSnapshotText(segment)) return;
      emitLiveSnapshot(segment, { state: 'streaming' });
    }, delayMs);
    timer.unref?.();
    segment.liveSnapshotTimer = timer;
  };

  const maybeEmitLiveStreamingSnapshot = (segment: SegmentRuntime) => {
    if (typeof session.sendAgentMessageEphemeral !== 'function') return;

    if (!segment.didWriteLive) {
      emitLiveSnapshot(segment, { state: 'streaming' });
      return;
    }

    if (!hasDirtyLiveSnapshotText(segment)) return;

    const isPureAppend = segment.appendOnlySinceLastLiveSnapshot;
    const addedChars = isPureAppend
      ? segment.accumulatedText.length - segment.lastLiveSnapshotTextLen
      : liveSnapshotMinChars;
    const elapsedMs = Date.now() - segment.lastLiveSnapshotAtMs;
    const shouldEmitImmediately =
      !isPureAppend
        ? true
        : liveSnapshotIntervalMs <= 0
        ? addedChars >= liveSnapshotMinChars
        : elapsedMs >= liveSnapshotIntervalMs && addedChars >= liveSnapshotMinChars;

    if (shouldEmitImmediately) {
      emitLiveSnapshot(segment, { state: 'streaming' });
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
    segment.appendOnlySinceLastLiveSnapshot = false;
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
    const flushedSegments = Array.from(segments.values());

    for (const segment of flushedSegments) {
      clearDurableCheckpointTimer(segment);
      clearLiveSnapshotTimer(segment);
      emitLiveSnapshot(segment, { state, interruptedReason: opts.interruptedReason });
      commitDurableSnapshot(segment, { state, interruptedReason: opts.interruptedReason, force: true });
      drainPromises.push(waitForSegmentDrain(segment));
      segments.delete(segment.key);
    }

    await Promise.all(drainPromises);
    return buildFlushSummary({ flushedSegments, expectedState: state });
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
