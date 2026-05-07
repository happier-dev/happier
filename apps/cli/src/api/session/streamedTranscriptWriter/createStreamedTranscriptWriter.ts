import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';

import type { ACPProvider } from '../sessionMessageTypes';
import {
  resolveCheckpointIntervalMs,
  resolveCheckpointMinChars,
  resolveInitialCheckpointDelayMs,
  resolveLiveSnapshotIntervalMs,
  resolveLiveSnapshotMinChars,
} from './env';
import { buildStreamedTranscriptSegmentKey, type StreamedTranscriptSegmentKey, type StreamedTranscriptSegmentKind } from './segmentKey';
import { commitStreamedTranscriptSegmentSnapshot } from './commitStreamedTranscriptSegmentSnapshot';
import {
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
}): StreamedTranscriptWriter {
  const provider = params.provider;
  const session = params.session;
  const makeLocalId = typeof params.makeLocalId === 'function' ? params.makeLocalId : () => randomUUID();

  const initialCheckpointDelayMs = resolveInitialCheckpointDelayMs(params.initialCheckpointDelayMs);
  const checkpointIntervalMs = resolveCheckpointIntervalMs(params.checkpointIntervalMs);
  const checkpointMinChars = resolveCheckpointMinChars(params.checkpointMinChars);
  const liveSnapshotIntervalMs = resolveLiveSnapshotIntervalMs(params.liveSnapshotIntervalMs);
  const liveSnapshotMinChars = resolveLiveSnapshotMinChars(params.liveSnapshotMinChars);

  const segments = new Map<SegmentKey, SegmentRuntime>();

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

  const commitDurableSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string }) => {
    clearDurableCheckpointTimer(segment);
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
      lastDurableText: '',
      lastCheckpointAtMs: 0,
      lastCheckpointTextLen: 0,
      lastCommittedTextVersion: 0,
      lastCommittedState: null,
      lastCommitFailedAtMs: 0,
      lastLiveSnapshotAtMs: 0,
      lastLiveSnapshotTextLen: 0,
      lastLiveSnapshotText: '',
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

  const hasDirtyDurableText = (segment: SegmentRuntime) => segment.accumulatedText !== segment.lastDurableText;

  const getDirtyAppendChars = (segment: SegmentRuntime) => {
    if (!segment.accumulatedText.startsWith(segment.lastDurableText)) return checkpointMinChars;
    return segment.accumulatedText.length - segment.lastDurableText.length;
  };

  const commitScheduledDurableSnapshot = (segment: SegmentRuntime) => {
    if (!segments.has(segment.key)) return;
    if (!hasDirtyDurableText(segment)) return;
    commitDurableSnapshot(segment, { state: 'streaming' });
  };

  const scheduleDurableCheckpoint = (segment: SegmentRuntime) => {
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

  const emitLiveSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string }) => {
    if (typeof session.sendAgentMessageEphemeral !== 'function') return;

    clearLiveSnapshotTimer(segment);

    const nowMs = Date.now();
    const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
    const meta = buildStreamedTranscriptSegmentSnapshotMeta({
      segment,
      state: opts.state,
      interruptedReason: opts.interruptedReason,
      nowMs,
    });

    try {
      void Promise.resolve(
        session.sendAgentMessageEphemeral(provider, body, {
          localId: segment.segmentLocalId,
          meta,
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
    } catch (error) {
      logger.debug('[StreamedTranscriptWriter] Live snapshot emit failed synchronously (non-fatal)', {
        error,
        localId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      });
    }

    segment.didWriteLive = true;
    segment.lastLiveSnapshotAtMs = nowMs;
    segment.lastLiveSnapshotTextLen = segment.accumulatedText.length;
    segment.lastLiveSnapshotText = segment.accumulatedText;
  };

  const scheduleLiveSnapshot = (segment: SegmentRuntime) => {
    if (typeof session.sendAgentMessageEphemeral !== 'function') return;
    if (segment.liveSnapshotTimer) return;
    if (segment.accumulatedText === segment.lastLiveSnapshotText) return;

    const elapsedMs = Date.now() - segment.lastLiveSnapshotAtMs;
    const delayMs = liveSnapshotIntervalMs <= 0 ? 0 : Math.max(0, liveSnapshotIntervalMs - elapsedMs);
    const timer = setTimeout(() => {
      segment.liveSnapshotTimer = null;
      if (!segments.has(segment.key)) return;
      if (segment.accumulatedText === segment.lastLiveSnapshotText) return;
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

    if (segment.accumulatedText === segment.lastLiveSnapshotText) return;

    const isPureAppend = segment.accumulatedText.startsWith(segment.lastLiveSnapshotText);
    const addedChars = isPureAppend
      ? segment.accumulatedText.length - segment.lastLiveSnapshotText.length
      : liveSnapshotMinChars;
    const elapsedMs = Date.now() - segment.lastLiveSnapshotAtMs;
    const shouldEmitImmediately = !isPureAppend
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

  const appendDelta = (kind: SegmentKind, deltaText: string, sidechainId: string | null) => {
    if (!deltaText) return;

    const segment = getOrCreateSegment(kind, sidechainId);
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
    segment.textVersion += 1;
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
      commitDurableSnapshot(segment, { state, interruptedReason: opts.interruptedReason });
      drainPromises.push(waitForSegmentDrain(segment));
      segments.delete(segment.key);
    }

    await Promise.all(drainPromises);
    return buildFlushSummary({ flushedSegments, expectedState: state });
  };

  return {
    appendAssistantDelta: (deltaText, opts) => appendDelta('assistant', deltaText, normalizeSidechainId(opts?.sidechainId)),
    appendThinkingDelta: (deltaText, opts) => appendDelta('thinking', deltaText, normalizeSidechainId(opts?.sidechainId)),
    overrideAssistantText: (text, opts) => overrideSegmentText('assistant', text, normalizeSidechainId(opts?.sidechainId)),
    overrideThinkingText: (text, opts) => overrideSegmentText('thinking', text, normalizeSidechainId(opts?.sidechainId)),
    flushAll,
  };
}
