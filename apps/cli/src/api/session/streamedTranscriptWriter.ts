import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { ACPMessageData, ACPProvider } from './sessionMessageTypes';

type SegmentKind = 'assistant' | 'thinking';
type SegmentState = 'streaming' | 'complete' | 'interrupted';

export type StreamedTranscriptWriterSession = Readonly<{
  sendAgentMessage?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  sendTranscriptDraftDelta: (
    provider: ACPProvider,
    params: {
      localId: string;
      segmentKind: SegmentKind;
      sidechainId: string | null;
      deltaText: string;
      createdAtMs: number;
    },
  ) => void;
}>;

export type StreamedTranscriptWriter = Readonly<{
  appendAssistantDelta: (deltaText: string, opts?: { sidechainId?: string | null }) => void;
  appendThinkingDelta: (deltaText: string, opts?: { sidechainId?: string | null }) => void;
  overrideAssistantText: (text: string, opts?: { sidechainId?: string | null }) => void;
  overrideThinkingText: (text: string, opts?: { sidechainId?: string | null }) => void;
  flushAll: (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }) => Promise<void>;
}>;

const DEFAULT_DRAFT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 1_000;
const DEFAULT_CHECKPOINT_MIN_CHARS = 128;

function resolveNonNegativeIntEnv(input: unknown, fallback: number): number {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.trunc(input);
  const raw = (input ?? '').toString().trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

function resolveDraftFlushIntervalMs(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? process.env.HAPPIER_STREAM_DRAFT_FLUSH_MS,
    DEFAULT_DRAFT_FLUSH_INTERVAL_MS,
  );
}

function resolveCheckpointIntervalMs(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? process.env.HAPPIER_STREAM_CHECKPOINT_MS,
    DEFAULT_CHECKPOINT_INTERVAL_MS,
  );
}

function resolveCheckpointMinChars(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS,
    DEFAULT_CHECKPOINT_MIN_CHARS,
  );
}

type SegmentKey = string;

function buildSegmentKey(kind: SegmentKind, sidechainId: string | null): SegmentKey {
  return `${kind}:${sidechainId ?? 'main'}`;
}

type SegmentRuntime = {
  key: SegmentKey;
  kind: SegmentKind;
  sidechainId: string | null;
  segmentLocalId: string;
  startedAtMs: number;
  accumulatedText: string;
  pendingDraftDeltaText: string;
  pendingDraftDeltaTextBeforeFirstCommit: string;
  draftFlushTimer: ReturnType<typeof setTimeout> | null;
  didWriteDurable: boolean;
  didResolveFirstDurableCommit: boolean;
  lastCheckpointAtMs: number;
  lastCheckpointTextLen: number;
  isCommittingDurable: boolean;
  pendingDurableCommit: { state: SegmentState; interruptedReason?: string } | null;
  idleWaiters: Array<() => void>;
};

export function createStreamedTranscriptWriter(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  makeLocalId?: () => string;
  draftFlushIntervalMs?: number | null;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
}): StreamedTranscriptWriter {
  const provider = params.provider;
  const session = params.session;
  const makeLocalId = typeof params.makeLocalId === 'function' ? params.makeLocalId : () => randomUUID();

  const draftFlushIntervalMs = resolveDraftFlushIntervalMs(params.draftFlushIntervalMs);
  const checkpointIntervalMs = resolveCheckpointIntervalMs(params.checkpointIntervalMs);
  const checkpointMinChars = resolveCheckpointMinChars(params.checkpointMinChars);

  const segments = new Map<SegmentKey, SegmentRuntime>();

  const flushDraftBuffer = (segment: SegmentRuntime) => {
    if (segment.draftFlushTimer) {
      clearTimeout(segment.draftFlushTimer);
      segment.draftFlushTimer = null;
    }
    const buffered = segment.pendingDraftDeltaText;
    segment.pendingDraftDeltaText = '';
    if (!buffered) return;
    session.sendTranscriptDraftDelta(provider, {
      localId: segment.segmentLocalId,
      segmentKind: segment.kind,
      sidechainId: segment.sidechainId,
      deltaText: buffered,
      createdAtMs: Date.now(),
    });
  };

  const enqueueDraftFlush = (segment: SegmentRuntime) => {
    if (!segment.pendingDraftDeltaText) return;

    if (draftFlushIntervalMs === 0) {
      flushDraftBuffer(segment);
      return;
    }

    if (!segment.draftFlushTimer) {
      segment.draftFlushTimer = setTimeout(() => flushDraftBuffer(segment), draftFlushIntervalMs);
      segment.draftFlushTimer.unref?.();
    }
  };

  const commitDurableSnapshot = (segment: SegmentRuntime, opts: { state: SegmentState; interruptedReason?: string }) => {
    if (segment.isCommittingDurable) {
      segment.pendingDurableCommit = opts;
      return;
    }

    segment.isCommittingDurable = true;

    const nowMs = Date.now();
    const durableLocalId = segment.segmentLocalId;
    const body: ACPMessageData =
      segment.kind === 'assistant'
        ? {
            type: 'message',
            message: segment.accumulatedText,
            ...(segment.sidechainId ? { sidechainId: segment.sidechainId } : {}),
          }
        : {
            type: 'thinking',
            text: segment.accumulatedText,
            ...(segment.sidechainId ? { sidechainId: segment.sidechainId } : {}),
          };

    const meta: Record<string, unknown> = {
      happierStreamSegmentV1: {
        v: 1,
        segmentKind: segment.kind,
        segmentLocalId: segment.segmentLocalId,
        segmentState: opts.state,
        startedAtMs: segment.startedAtMs,
        updatedAtMs: nowMs,
        ...(opts.state === 'interrupted' && typeof opts.interruptedReason === 'string' && opts.interruptedReason
          ? { interruptedReason: opts.interruptedReason }
          : {}),
      },
    };

    void session
      .sendAgentMessageCommitted(provider, body, { localId: durableLocalId, meta })
      .catch((error) => {
        logger.debug('[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)', {
          error,
          localId: durableLocalId,
          segmentLocalId: segment.segmentLocalId,
          kind: segment.kind,
          sidechainId: segment.sidechainId,
        });

        if (typeof session.sendAgentMessage === 'function') {
          try {
            session.sendAgentMessage(provider, body, { localId: durableLocalId, meta });
          } catch (fallbackError) {
            logger.debug('[StreamedTranscriptWriter] Durable snapshot fallback commit failed (non-fatal)', {
              error: fallbackError,
              localId: durableLocalId,
              segmentLocalId: segment.segmentLocalId,
              kind: segment.kind,
              sidechainId: segment.sidechainId,
            });
          }
        }
      })
      .finally(() => {
        segment.isCommittingDurable = false;
        if (!segment.didResolveFirstDurableCommit) {
          segment.didResolveFirstDurableCommit = true;
          const bufferedDraftText = segment.pendingDraftDeltaTextBeforeFirstCommit;
          segment.pendingDraftDeltaTextBeforeFirstCommit = '';
          if (bufferedDraftText && segments.has(segment.key)) {
            segment.pendingDraftDeltaText += bufferedDraftText;
            flushDraftBuffer(segment);
          }
        }
        const pendingCommit = segment.pendingDurableCommit;
        segment.pendingDurableCommit = null;
        if (pendingCommit) {
          commitDurableSnapshot(segment, pendingCommit);
          return;
        }
        if (segment.idleWaiters.length === 0) return;
        const waiters = segment.idleWaiters.splice(0, segment.idleWaiters.length);
        for (const waiter of waiters) {
          waiter();
        }
      });

    segment.didWriteDurable = true;
    segment.lastCheckpointAtMs = nowMs;
    segment.lastCheckpointTextLen = segment.accumulatedText.length;
  };

  const getOrCreateSegment = (kind: SegmentKind, sidechainId: string | null): SegmentRuntime => {
    const key = buildSegmentKey(kind, sidechainId);
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
      pendingDraftDeltaText: '',
      pendingDraftDeltaTextBeforeFirstCommit: '',
      draftFlushTimer: null,
      didWriteDurable: false,
      didResolveFirstDurableCommit: false,
      lastCheckpointAtMs: 0,
      lastCheckpointTextLen: 0,
      isCommittingDurable: false,
      pendingDurableCommit: null,
      idleWaiters: [],
    };
    segments.set(key, created);
    return created;
  };

  const waitForSegmentDrain = (segment: SegmentRuntime): Promise<void> => {
    if (!segment.isCommittingDurable && !segment.pendingDurableCommit) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      segment.idleWaiters.push(resolve);
    });
  };

  const appendDelta = (kind: SegmentKind, deltaText: string, sidechainId: string | null) => {
    if (!deltaText) return;

    const segment = getOrCreateSegment(kind, sidechainId);
    segment.accumulatedText += deltaText;

    if (!segment.didWriteDurable) {
      commitDurableSnapshot(segment, { state: 'streaming' });
      return;
    }

    if (!segment.didResolveFirstDurableCommit) {
      segment.pendingDraftDeltaTextBeforeFirstCommit += deltaText;
    } else {
      segment.pendingDraftDeltaText += deltaText;
      enqueueDraftFlush(segment);
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

  const overrideSegmentText = (kind: SegmentKind, text: string, sidechainId: string | null) => {
    const segment = getOrCreateSegment(kind, sidechainId);
    segment.accumulatedText = text;
  };

  const flushAll = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }): Promise<void> => {
    const state: SegmentState = opts.reason === 'abort' ? 'interrupted' : 'complete';
    const drainPromises: Promise<void>[] = [];

    for (const segment of segments.values()) {
      flushDraftBuffer(segment);
      commitDurableSnapshot(segment, { state, interruptedReason: opts.interruptedReason });
      drainPromises.push(waitForSegmentDrain(segment));
      segments.delete(segment.key);
    }

    await Promise.all(drainPromises);
  };

  const normalizeSidechainId = (input: unknown): string | null => {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    return trimmed ? trimmed : null;
  };

  return {
    appendAssistantDelta: (deltaText, opts) => appendDelta('assistant', deltaText, normalizeSidechainId(opts?.sidechainId)),
    appendThinkingDelta: (deltaText, opts) => appendDelta('thinking', deltaText, normalizeSidechainId(opts?.sidechainId)),
    overrideAssistantText: (text, opts) => overrideSegmentText('assistant', text, normalizeSidechainId(opts?.sidechainId)),
    overrideThinkingText: (text, opts) => overrideSegmentText('thinking', text, normalizeSidechainId(opts?.sidechainId)),
    flushAll,
  };
}
