import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';

import type { ACPProvider } from '../sessionMessageTypes';
import {
  resolveCheckpointIntervalMs,
  resolveCheckpointMinChars,
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
import type { StreamedTranscriptWriter, StreamedTranscriptWriterSession } from './types';

type SegmentKind = StreamedTranscriptSegmentKind;
type SegmentState = StreamedTranscriptSegmentState;

type SegmentKey = StreamedTranscriptSegmentKey;

type SegmentRuntime = StreamedTranscriptSegmentRuntime;

export function createStreamedTranscriptWriter(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  makeLocalId?: () => string;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
  liveSnapshotIntervalMs?: number | null;
  liveSnapshotMinChars?: number | null;
}): StreamedTranscriptWriter {
  const provider = params.provider;
  const session = params.session;
  const makeLocalId = typeof params.makeLocalId === 'function' ? params.makeLocalId : () => randomUUID();

  const checkpointIntervalMs = resolveCheckpointIntervalMs(params.checkpointIntervalMs);
  const checkpointMinChars = resolveCheckpointMinChars(params.checkpointMinChars);
  const liveSnapshotIntervalMs = resolveLiveSnapshotIntervalMs(params.liveSnapshotIntervalMs);
  const liveSnapshotMinChars = resolveLiveSnapshotMinChars(params.liveSnapshotMinChars);

  const segments = new Map<SegmentKey, SegmentRuntime>();

  const commitDurableSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string }) => {
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
      didWriteDurable: false,
      didWriteLive: false,
      lastCheckpointAtMs: 0,
      lastCheckpointTextLen: 0,
      lastLiveSnapshotAtMs: 0,
      lastLiveSnapshotTextLen: 0,
      lastLiveSnapshotText: '',
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

  const emitLiveSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string }) => {
    const sendLiveSnapshot = session.sendAgentMessageEphemeral;
    if (typeof sendLiveSnapshot !== 'function') return;

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
        sendLiveSnapshot(provider, body, {
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

    if (segment.accumulatedText === segment.lastLiveSnapshotText) {
      return;
    }

    const isPureAppend = segment.accumulatedText.startsWith(segment.lastLiveSnapshotText);
    const addedChars = isPureAppend
      ? segment.accumulatedText.length - segment.lastLiveSnapshotText.length
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

  const appendDelta = (kind: SegmentKind, deltaText: string, sidechainId: string | null) => {
    if (!deltaText) return;

    const segment = getOrCreateSegment(kind, sidechainId);
    segment.accumulatedText += deltaText;
    maybeEmitLiveStreamingSnapshot(segment);

    if (!segment.didWriteDurable) {
      commitDurableSnapshot(segment, { state: 'streaming' });
      return;
    }

    const nowMs = Date.now();
    if (checkpointIntervalMs === 0) {
      if (segment.accumulatedText.length - segment.lastCheckpointTextLen >= checkpointMinChars) {
        commitDurableSnapshot(segment, { state: 'streaming' });
      }
      return;
    }

    if (nowMs - segment.lastCheckpointAtMs < checkpointIntervalMs) return;
    if (segment.accumulatedText.length - segment.lastCheckpointTextLen < checkpointMinChars) return;
    commitDurableSnapshot(segment, { state: 'streaming' });
  };

  const overrideSegmentText = (kind: SegmentKind, text: string, sidechainId: string | null): boolean => {
    const segment = getExistingSegment(kind, sidechainId);
    if (!segment) return false;
    segment.accumulatedText = text;
    maybeEmitLiveStreamingSnapshot(segment);
    return true;
  };

  const flushAll = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }): Promise<void> => {
    const state: SegmentState = opts.reason === 'abort' ? 'interrupted' : 'complete';
    const drainPromises: Promise<void>[] = [];

    for (const segment of segments.values()) {
      clearLiveSnapshotTimer(segment);
      emitLiveSnapshot(segment, { state, interruptedReason: opts.interruptedReason });
      commitDurableSnapshot(segment, { state, interruptedReason: opts.interruptedReason });
      drainPromises.push(waitForSegmentDrain(segment));
      segments.delete(segment.key);
    }

    await Promise.all(drainPromises);
  };

  return {
    appendAssistantDelta: (deltaText, opts) => appendDelta('assistant', deltaText, normalizeSidechainId(opts?.sidechainId)),
    appendThinkingDelta: (deltaText, opts) => appendDelta('thinking', deltaText, normalizeSidechainId(opts?.sidechainId)),
    overrideAssistantText: (text, opts) => overrideSegmentText('assistant', text, normalizeSidechainId(opts?.sidechainId)),
    overrideThinkingText: (text, opts) => overrideSegmentText('thinking', text, normalizeSidechainId(opts?.sidechainId)),
    flushAll,
  };
}
