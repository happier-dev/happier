import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import type { ACPProvider } from './sessionMessageTypes';
import {
  createStreamedTranscriptWriter,
  type StreamedTranscriptWriter,
  type StreamedTranscriptWriterSession,
} from './streamedTranscriptWriter';

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const TEST_PROVIDER = 'codex' satisfies ACPProvider;

type DurableCall = {
  provider: string;
  localId: string;
  meta: Record<string, unknown> | undefined;
  body: unknown;
};

type LiveCall = DurableCall & {
  createdAt: number;
  updatedAt: number;
};

function createSessionStub(opts: { withLive?: boolean } = {}) {
  const durableCalls: DurableCall[] = [];
  const bestEffortCalls: DurableCall[] = [];
  const liveCalls: LiveCall[] = [];

  const session: Mutable<StreamedTranscriptWriterSession> = {
    sendAgentMessage: (provider, body, opts) => {
      bestEffortCalls.push({
        provider: String(provider),
        localId: typeof opts?.localId === 'string' ? opts.localId : '',
        meta: opts?.meta,
        body,
      });
    },
    ...(opts.withLive
      ? {
          sendAgentMessageEphemeral: (provider, body, opts) => {
            liveCalls.push({
              provider: String(provider),
              localId: String(opts.localId),
              meta: opts?.meta,
              body,
              createdAt: Number(opts.createdAt),
              updatedAt: Number(opts.updatedAt),
            });
            return { accepted: true as const, epoch: 0 };
          },
        }
      : {}),
    sendAgentMessageCommitted: async (provider, body, opts) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
    },
  };

  return { session, durableCalls, bestEffortCalls, liveCalls };
}

async function settleCommittedSnapshot() {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('createStreamedTranscriptWriter', () => {
  it('emits live snapshots ahead of durable checkpoints and flushes the latest text on the live cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls, liveCalls } = createSessionStub({ withLive: true });

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    writer.appendAssistantDelta('H');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'segment-1',
      body: { type: 'message', message: 'H' },
    });

    vi.advanceTimersByTime(10);
    writer.appendAssistantDelta('i');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(liveCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30);
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(liveCalls).toHaveLength(2);
    expect(liveCalls[1]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'segment-1',
      body: { type: 'message', message: 'Hi' },
    });

    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(liveCalls[liveCalls.length - 1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
    expect(durableCalls[durableCalls.length - 1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('preserves the session receiver when emitting live snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const liveCalls: LiveCall[] = [];
    const session: StreamedTranscriptWriterSession & { liveCalls: LiveCall[] } = {
      liveCalls,
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageEphemeral(provider, body, opts) {
        this.liveCalls.push({
          provider: String(provider),
          localId: String(opts.localId),
          meta: opts?.meta,
          body,
          createdAt: Number(opts.createdAt),
          updatedAt: Number(opts.updatedAt),
        });
        return { accepted: true as const, epoch: 0 };
      },
    };

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    writer.appendAssistantDelta('H');
    await settleCommittedSnapshot();

    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'segment-1',
      body: { type: 'message', message: 'H' },
    });
  });

  it('keeps live partial snapshots ephemeral while durable committed snapshots go through the outbox hook', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const liveCalls: LiveCall[] = [];
    const outboxCalls: DurableCall[] = [];
    const session: StreamedTranscriptWriterSession = {
      enqueueAgentMessageCommitted: vi.fn(async (provider, body, opts) => {
        outboxCalls.push({
          provider: String(provider),
          localId: String(opts.localId),
          meta: opts.meta,
          body,
        });
        return { persisted: true, delivered: false };
      }),
      sendAgentMessageCommitted: vi.fn(async () => {
        throw new Error('direct committed path should not be used when outbox hook exists');
      }),
      sendAgentMessageEphemeral(provider, body, opts) {
        liveCalls.push({
          provider: String(provider),
          localId: String(opts.localId),
          meta: opts?.meta,
          body,
          createdAt: Number(opts.createdAt),
          updatedAt: Number(opts.updatedAt),
        });
        return { accepted: true as const, epoch: 0 };
      },
    };

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    writer.setCommitProvenance({ kind: 'non_dependent', source: 'external' });
    writer.appendAssistantDelta('partial');
    await settleCommittedSnapshot();

    expect(liveCalls).toHaveLength(1);
    expect(outboxCalls).toHaveLength(0);

    await writer.flushAll({ reason: 'turn-end' });

    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(outboxCalls).toEqual([
      expect.objectContaining({
        provider: TEST_PROVIDER,
        localId: 'segment-1',
        body: { type: 'message', message: 'partial' },
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
        }),
      }),
    ]);
  });

  it('delays the first durable checkpoint until the configured initial checkpoint delay when live snapshots are available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls, liveCalls } = createSessionStub({ withLive: true });

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'l1',
      initialCheckpointDelayMs: 200,
      checkpointIntervalMs: 2_000,
      checkpointMinChars: 256,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();

    expect(liveCalls).toHaveLength(1);
    expect(durableCalls).toHaveLength(0);

    vi.advanceTimersByTime(199);
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'l1',
      body: { type: 'message', message: 'Hello' },
    });
  });

  it('emits a scheduled durable checkpoint after the interval even without another delta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub({ withLive: true });

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'l1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 50,
      checkpointMinChars: 1,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    writer.appendAssistantDelta(' world');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'l1',
      body: { type: 'message', message: 'Hello world' },
    });
  });

  it('emits durable checkpoints on the configured interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'l1',
      checkpointIntervalMs: 50,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    writer.appendAssistantDelta(' world');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(49);
    await settleCommittedSnapshot();
    writer.appendAssistantDelta('!');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'l1',
      body: { type: 'message', message: 'Hello world!' },
    });

    writer.appendAssistantDelta('?');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(50);
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(3);
    expect(durableCalls[2]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'l1',
      body: { type: 'message', message: 'Hello world!?' },
    });
  });

  it('writes durable checkpoints by reusing the segment localId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const ids = ['segment-1'];

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => ids.shift() ?? 'missing',
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);

    vi.setSystemTime(new Date(1_000));
    writer.appendAssistantDelta(' world');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[0]!.localId).toBe('segment-1');
    expect(durableCalls[1]!.localId).toBe('segment-1');
    expect(durableCalls[1]!.body).toMatchObject({ type: 'message', message: 'Hello world' });
    expect(durableCalls[0]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentLocalId: 'segment-1', segmentState: 'streaming' }),
    });
    expect(durableCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentLocalId: 'segment-1', segmentState: 'streaming' }),
    });
  });

  it('emits a durable checkpoint for each delta when checkpointIntervalMs is zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'segment-1',
      body: { type: 'message', message: 'Hello' },
    });

    writer.appendAssistantDelta(' world');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]).toMatchObject({
      provider: TEST_PROVIDER,
      localId: 'segment-1',
      body: { type: 'message', message: 'Hello world' },
    });
  });

  it('flushes and completes segments at a tool-call boundary while keeping the same segment localId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const ids = ['segment-1', 'segment-2'];

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => ids.shift() ?? 'missing',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();
    writer.appendAssistantDelta(' world');

    expect(durableCalls).toHaveLength(1);

    await writer.flushAll({ reason: 'tool-call-boundary' });
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[0]!.localId).toBe('segment-1');
    expect(durableCalls[1]!.localId).toBe('segment-1');
    expect(durableCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentLocalId: 'segment-1', segmentState: 'complete' }),
    });

    writer.appendAssistantDelta('Next');
    await Promise.resolve();

    expect(durableCalls).toHaveLength(3);
    expect(durableCalls[2]!.localId).toBe('segment-2');
    expect(durableCalls[2]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentLocalId: 'segment-2', segmentState: 'streaming' }),
    });
  });

  it('flushes interrupted segments on abort and preserves sidechainId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'l1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendThinkingDelta('...', { sidechainId: 'sc-1' });
    await settleCommittedSnapshot();
    writer.appendThinkingDelta(' next', { sidechainId: 'sc-1' });

    await writer.flushAll({ reason: 'abort', interruptedReason: 'cancelled' });
    await settleCommittedSnapshot();

    expect(durableCalls.length).toBeGreaterThanOrEqual(2);
    expect(durableCalls[durableCalls.length - 1]!.body).toMatchObject({ type: 'thinking', sidechainId: 'sc-1' });
    expect(durableCalls[durableCalls.length - 1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'interrupted', interruptedReason: 'cancelled' }),
    });
  });

  it('can override the durable assistant text without emitting replacement draft deltas', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('READY ');
    await settleCommittedSnapshot();

    writer.overrideAssistantText('READY_FOR_FOLLOWUP');
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[0]!.body).toMatchObject({ type: 'message', message: 'READY ' });
    expect(durableCalls[1]!.body).toMatchObject({ type: 'message', message: 'READY_FOR_FOLLOWUP' });
    expect(durableCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('can override the assistant segment most recently flushed at a tool boundary', async () => {
    const { session, durableCalls } = createSessionStub();
    let segmentOrdinal = 0;
    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => `segment-${++segmentOrdinal}`,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Draft.');
    await writer.flushAll({ reason: 'tool-call-boundary' });

    const didOverride = writer.overrideAssistantText('Final.');
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(didOverride).toBe(true);
    expect(durableCalls.at(-1)).toMatchObject({
      localId: 'segment-1',
      body: { type: 'message', message: 'Final.' },
    });
    expect(new Set(durableCalls.map((call) => call.localId))).toEqual(new Set(['segment-1']));
    expect(writer.overrideAssistantText('Stale.')).toBe(false);
  });

  it('does not reuse a durably cleared segment for later text', async () => {
    const { session, durableCalls } = createSessionStub();
    let segmentOrdinal = 0;
    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => `segment-${++segmentOrdinal}`,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Draft.');
    expect(writer.overrideAssistantText('')).toBe(true);
    await writer.flushAll({ reason: 'turn-end' });

    writer.appendAssistantDelta('Next turn.');
    await writer.flushAll({ reason: 'turn-end' });

    expect(durableCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        localId: 'segment-1',
        body: { type: 'message', message: '' },
      }),
      expect.objectContaining({
        localId: 'segment-2',
        body: { type: 'message', message: 'Next turn.' },
      }),
    ]));
  });

  it('keeps a completed tool-boundary rewrite complete when the turn aborts', async () => {
    const { session, durableCalls } = createSessionStub();
    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Draft.');
    await writer.flushAll({ reason: 'tool-call-boundary' });
    expect(writer.overrideAssistantText('Final.')).toBe(true);

    await expect(writer.flushAll({ reason: 'abort', interruptedReason: 'cancelled' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: true },
    });
    expect(durableCalls.at(-1)).toMatchObject({
      localId: 'segment-1',
      body: { type: 'message', message: 'Final.' },
      meta: { happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }) },
    });
  });

  it('does not append post-tool text into a failed tool-boundary segment', async () => {
    const { session } = createSessionStub();
    let segmentOrdinal = 0;
    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => `segment-${++segmentOrdinal}`,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    session.sendAgentMessageCommitted = async () => {
      throw new Error('transcript unavailable');
    };
    writer.appendAssistantDelta('Before tool.');
    await expect(writer.flushAll({ reason: 'tool-call-boundary' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: false },
    });

    const retryCalls: Array<{ localId: string; body: unknown }> = [];
    session.sendAgentMessageCommitted = async (_provider, body, opts) => {
      retryCalls.push({ localId: String(opts.localId), body });
    };
    writer.appendAssistantDelta('After tool.');
    await writer.flushAll({ reason: 'turn-end' });

    expect(retryCalls).toEqual(expect.arrayContaining([
      { localId: 'segment-1', body: { type: 'message', message: 'Before tool.' } },
      { localId: 'segment-2', body: { type: 'message', message: 'After tool.' } },
    ]));
  });

  it('keeps overlapping failed tool-boundary segments isolated from later text', async () => {
    const { session } = createSessionStub({ withLive: true });
    const firstCommit = createDeferred<void>();
    const secondCommit = createDeferred<void>();
    const pendingCommits = [firstCommit, secondCommit];
    let segmentOrdinal = 0;
    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => `segment-${++segmentOrdinal}`,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    session.sendAgentMessageCommitted = async () => {
      const commit = pendingCommits.shift();
      if (!commit) throw new Error('unexpected commit');
      await commit.promise;
    };

    writer.appendAssistantDelta('First.');
    const firstFlush = writer.flushAll({ reason: 'tool-call-boundary' });
    writer.appendAssistantDelta('Second.');
    const secondFlush = writer.flushAll({ reason: 'tool-call-boundary' });

    firstCommit.reject(new Error('first unavailable'));
    secondCommit.reject(new Error('second unavailable'));
    await Promise.all([firstFlush, secondFlush]);

    const retryCalls: Array<{ localId: string; body: unknown }> = [];
    session.sendAgentMessageCommitted = async (_provider, body, opts) => {
      retryCalls.push({ localId: String(opts.localId), body });
    };
    writer.appendAssistantDelta('Third.');
    await writer.flushAll({ reason: 'turn-end' });

    expect(retryCalls).toEqual(expect.arrayContaining([
      { localId: 'segment-1', body: { type: 'message', message: 'First.' } },
      { localId: 'segment-2', body: { type: 'message', message: 'Second.' } },
      { localId: 'segment-3', body: { type: 'message', message: 'Third.' } },
    ]));
  });

  it('reports and retries a failed replacement of a tool-boundary rewrite candidate', async () => {
    const { session } = createSessionStub();
    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Draft.');
    await writer.flushAll({ reason: 'tool-call-boundary' });
    session.sendAgentMessageCommitted = async () => {
      throw new Error('replacement unavailable');
    };

    expect(writer.overrideAssistantText('Final.')).toBe(true);
    await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: false },
    });

    session.sendAgentMessageCommitted = async () => {};
    await expect(writer.flushAll({ reason: 'tool-call-boundary' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: true },
    });
  });

  it('retries both a failed rewrite candidate and a newer failed active segment', async () => {
    const { session } = createSessionStub();
    let segmentOrdinal = 0;
    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => `segment-${++segmentOrdinal}`,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Draft.');
    await writer.flushAll({ reason: 'tool-call-boundary' });
    session.sendAgentMessageCommitted = async () => {
      throw new Error('transcript unavailable');
    };

    expect(writer.overrideAssistantText('Final.')).toBe(true);
    writer.appendAssistantDelta('Newer.');
    await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: false },
    });

    const retryCalls: Array<{ localId: string; body: unknown }> = [];
    session.sendAgentMessageCommitted = async (_provider, body, opts) => {
      retryCalls.push({ localId: String(opts.localId), body });
    };
    await expect(writer.flushAll({ reason: 'tool-call-boundary' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: true },
    });
    expect(retryCalls).toEqual(expect.arrayContaining([
      { localId: 'segment-1', body: { type: 'message', message: 'Final.' } },
      { localId: 'segment-2', body: { type: 'message', message: 'Newer.' } },
    ]));
  });

  it('does not create a new durable segment when overrideAssistantText is called before any streamed delta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    const didOverride = writer.overrideAssistantText('FINAL');
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(didOverride).toBe(false);
    expect(durableCalls).toHaveLength(0);
  });

  it('reports a durable final turn flush when the committed snapshot succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    const flushSummary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(flushSummary).toMatchObject({
      assistant: { sawText: true, didDurablyFlush: true },
      assistantRoot: { sawText: true, didDurablyFlush: true },
      thinking: { sawText: false, didDurablyFlush: false },
      thinkingRoot: { sawText: false, didDurablyFlush: false },
    });
  });

  it('reports sidechain-only assistant flushes separately from the root assistant aggregate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello from sidechain', { sidechainId: 'sc-1' });
    const flushSummary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(flushSummary).toMatchObject({
      assistant: { sawText: true, didDurablyFlush: true },
      assistantRoot: { sawText: false, didDurablyFlush: false },
      segments: [
        expect.objectContaining({
          kind: 'assistant',
          sidechainId: 'sc-1',
          sawText: true,
          didDurablyFlush: true,
        }),
      ],
    });
  });

  it('does not route failed durable commits through best-effort commits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, bestEffortCalls } = createSessionStub();
    session.sendAgentMessageCommitted = async () => {
      throw new Error('boom');
    };

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'l1',
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();

    expect(bestEffortCalls).toHaveLength(0);
  });

  it('reports an incomplete durable final turn flush when durable commit fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, bestEffortCalls } = createSessionStub();
    session.sendAgentMessageCommitted = async () => {
      throw new Error('boom');
    };

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    const flushSummary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(bestEffortCalls).toHaveLength(0);
    expect(flushSummary).toMatchObject({
      assistant: { sawText: true, didDurablyFlush: false },
      assistantRoot: { sawText: true, didDurablyFlush: false },
      thinking: { sawText: false, didDurablyFlush: false },
      thinkingRoot: { sawText: false, didDurablyFlush: false },
    });
  });

  it('does not wait on best-effort commit plumbing after a durable commit failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session } = createSessionStub();

    session.sendAgentMessageCommitted = async () => {
      throw new Error('boom');
    };
    session.sendAgentMessage = vi.fn(() => new Promise<void>(() => {}));

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'l1',
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();

    let didResolveFlush = false;
    const flushPromise = writer.flushAll({ reason: 'turn-end' }).then(() => {
      didResolveFlush = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    await settleCommittedSnapshot();
    await settleCommittedSnapshot();

    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(didResolveFlush).toBe(true);
    await flushPromise;
  });

  it('prevents duplicate durable commits when flushAll is called concurrently or repeatedly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    // Append some content to create a segment
    writer.appendAssistantDelta('Hello world');
    await Promise.resolve();

    // Should have one initial durable commit from the first append
    expect(durableCalls).toHaveLength(1);
    const initialCommitCount = durableCalls.length;

    // Call flushAll twice in quick succession (simulating abort followed by turn-end)
    await Promise.all([
      writer.flushAll({ reason: 'abort', interruptedReason: 'cancelled' }),
      writer.flushAll({ reason: 'turn-end' }),
    ]);

    // Should have exactly ONE additional durable commit from the first flushAll
    // The second flushAll should NOT create a duplicate commit for the same segment/localId
    expect(durableCalls).toHaveLength(initialCommitCount + 1);

    // Verify the final commit has the expected content
    const finalCommit = durableCalls[durableCalls.length - 1];
    expect(finalCommit).toMatchObject({
      localId: 'segment-1',
      body: { type: 'message', message: 'Hello world' },
    });
  });

  it('waits for the final durable snapshot to finish before flushAll resolves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    let resolveFirstCommit: (() => void) | undefined;
    session.sendAgentMessageCommitted = vi.fn(async (provider, body, opts) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
      if (durableCalls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstCommit = resolve;
        });
      }
    });

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello world');
    await Promise.resolve();

    let didResolveFlush = false;
    const flushPromise = writer.flushAll({ reason: 'turn-end' }).then(() => {
      didResolveFlush = true;
    });

    await Promise.resolve();
    expect(didResolveFlush).toBe(false);
    expect(durableCalls).toHaveLength(1);

    const releaseFirstCommit = resolveFirstCommit;
    if (!releaseFirstCommit) {
      throw new Error('expected first durable commit resolver');
    }
    releaseFirstCommit();
    await flushPromise;

    expect(didResolveFlush).toBe(true);
    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('does not enqueue an extra streaming checkpoint when more deltas arrive before the first durable snapshot finishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    let resolveFirstCommit: (() => void) | undefined;
    session.sendAgentMessageCommitted = vi.fn(async (provider, body, opts) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
      if (durableCalls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstCommit = resolve;
        });
      }
    });

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    writer.appendAssistantDelta(' world');
    await Promise.resolve();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]!.body).toMatchObject({ type: 'message', message: 'Hello' });

    const releaseFirstCommit = resolveFirstCommit;
    if (!releaseFirstCommit) {
      throw new Error('expected first durable commit resolver');
    }
    releaseFirstCommit();
    await settleCommittedSnapshot();
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(durableCalls).toHaveLength(1);

    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]!.body).toMatchObject({ type: 'message', message: 'Hello world' });
    expect(durableCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('flushes the latest complete snapshot when flushAll runs immediately after another delta while the first durable snapshot is still in flight', async () => {
    const { session, durableCalls } = createSessionStub();
    session.sendAgentMessageCommitted = vi.fn(async (provider, body, opts) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
    });

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('The');
    writer.appendAssistantDelta(' directory is empty.');
    const flushPromise = writer.flushAll({ reason: 'tool-call-boundary' });

    await flushPromise;
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[0]!.body).toMatchObject({ type: 'message', message: 'The' });
    expect(durableCalls[1]!.body).toMatchObject({ type: 'message', message: 'The directory is empty.' });
    expect(durableCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('tracks an in-flight durable commit and drains it before flushAll resolves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    let resolveFirstCommit: (() => void) | undefined;
    session.sendAgentMessageCommitted = vi.fn(async (provider, body, opts) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
      if (durableCalls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstCommit = resolve;
        });
      }
    });

    const writer = createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    await Promise.resolve();

    let flushResolved = false;
    const flushPromise = writer.flushAll({ reason: 'turn-end' }).then(() => {
      flushResolved = true;
    });

    await Promise.resolve();
    expect(flushResolved).toBe(false);

    const release = resolveFirstCommit;
    if (!release) {
      throw new Error('expected first durable commit resolver');
    }
    release();
    await flushPromise;

    expect(flushResolved).toBe(true);
    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('redacts durable commit errors before logging', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const secretError = new Error(
      'commit failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/messages?token=secret Authorization: Bearer COMMIT_SECRET',
    );
    const session = {
      sendAgentMessageCommitted: vi.fn(async () => {
        throw secretError;
      }),
      sendAgentMessage: vi.fn(() => {
        throw secretError;
      }),
    };

    try {
      const writer = createStreamedTranscriptWriter({
        provider: TEST_PROVIDER,
        session,
        makeLocalId: () => 'segment-secret',
        initialCheckpointDelayMs: 0,
        checkpointIntervalMs: 1_000,
        checkpointMinChars: 1,
      });

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();

      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        error: expect.objectContaining({
          name: 'Error',
          message: 'commit failed for https://api.example.test/v1/messages Authorization: <redacted>',
        }),
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('COMMIT_SECRET');
      expect(JSON.stringify(logged)).not.toContain('stack');
      expect(session.sendAgentMessage).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

type LiveDeltaCall = {
  provider: string;
  localId: string;
  meta: Record<string, unknown> | undefined;
  body: unknown;
  tick: number;
  baseLength: number;
  createdAt: number;
  updatedAt: number;
};

function createDeltaSessionStub() {
  const liveCalls: LiveCall[] = [];
  const deltaCalls: LiveDeltaCall[] = [];
  const durableCalls: DurableCall[] = [];
  let connectionEpoch = 1;

  const session: StreamedTranscriptWriterSession = {
    sendAgentMessageCommitted: async (provider, body, opts) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
    },
    sendAgentMessageEphemeral: (provider, body, opts) => {
      liveCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts?.meta,
        body,
        createdAt: Number(opts.createdAt),
        updatedAt: Number(opts.updatedAt),
        ...(typeof opts.tick === 'number' ? { tick: opts.tick } : {}),
      });
      return { accepted: true as const, epoch: connectionEpoch };
    },
    sendAgentMessageEphemeralDelta: (provider, body, opts) => {
      deltaCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts?.meta,
        body,
        tick: Number(opts.tick),
        baseLength: Number(opts.baseLength),
        createdAt: Number(opts.createdAt),
        updatedAt: Number(opts.updatedAt),
      });
      return { accepted: true as const, epoch: connectionEpoch };
    },
    getEphemeralStreamConnectionEpoch: () => connectionEpoch,
  };

  return {
    session,
    liveCalls,
    deltaCalls,
    durableCalls,
    bumpConnectionEpoch: () => {
      connectionEpoch += 1;
    },
  };
}

describe('createStreamedTranscriptWriter delta live streaming', () => {
  const createDeltaWriter = (
    session: StreamedTranscriptWriterSession,
    overrides: Partial<Parameters<typeof createStreamedTranscriptWriter>[0]> = {},
  ): StreamedTranscriptWriter => {
    return createStreamedTranscriptWriter({
      provider: TEST_PROVIDER,
      session,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
      liveCheckpointIntervalMs: 1_000,
      ...overrides,
    });
  };

  it('emits a full snapshot first, then append-only deltas with chained ticks and base lengths', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls, deltaCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session);

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();

      expect(liveCalls).toHaveLength(1);
      expect(deltaCalls).toHaveLength(0);
      expect(liveCalls[0]).toMatchObject({
        localId: 'segment-1',
        body: { type: 'message', message: 'Hello' },
      });
      expect((liveCalls[0] as unknown as { tick?: number }).tick).toBe(1);

      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' wor');
      await settleCommittedSnapshot();

      expect(liveCalls).toHaveLength(1);
      expect(deltaCalls).toHaveLength(1);
      expect(deltaCalls[0]).toMatchObject({
        provider: TEST_PROVIDER,
        localId: 'segment-1',
        body: { type: 'message', message: ' wor' },
        tick: 2,
        baseLength: 5,
      });
      expect(deltaCalls[0]!.meta).toMatchObject({
        happierStreamSegmentV1: expect.objectContaining({ segmentState: 'streaming' }),
      });

      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta('ld');
      await settleCommittedSnapshot();

      expect(deltaCalls).toHaveLength(2);
      expect(deltaCalls[1]).toMatchObject({
        body: { type: 'message', message: 'ld' },
        tick: 3,
        baseLength: 9,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not scan accumulated text prefixes on append-only live delta appends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const startsWithSpy = vi.spyOn(String.prototype, 'startsWith');
    try {
      const { session, deltaCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session);

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();

      startsWithSpy.mockClear();
      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' world');
      const prefixScanCalls = startsWithSpy.mock.calls.length;

      await settleCommittedSnapshot();
      expect(deltaCalls).toHaveLength(1);
      expect(prefixScanCalls).toBe(0);
    } finally {
      startsWithSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('emits a full-snapshot checkpoint once the live checkpoint interval elapses, then resumes deltas', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls, deltaCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session);

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();
      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' world');
      await settleCommittedSnapshot();
      expect(liveCalls).toHaveLength(1);
      expect(deltaCalls).toHaveLength(1);

      vi.advanceTimersByTime(1_000);
      writer.appendAssistantDelta('!');
      await settleCommittedSnapshot();

      expect(deltaCalls).toHaveLength(1);
      expect(liveCalls).toHaveLength(2);
      expect(liveCalls[1]).toMatchObject({
        body: { type: 'message', message: 'Hello world!' },
      });
      expect((liveCalls[1] as unknown as { tick?: number }).tick).toBe(3);

      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta('?');
      await settleCommittedSnapshot();
      expect(deltaCalls).toHaveLength(2);
      expect(deltaCalls[1]).toMatchObject({
        body: { type: 'message', message: '?' },
        tick: 4,
        baseLength: 12,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a full snapshot when segment text is rewritten (non-append override)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls, deltaCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session);

      writer.appendAssistantDelta('Hello world');
      await settleCommittedSnapshot();
      expect(liveCalls).toHaveLength(1);

      vi.advanceTimersByTime(40);
      writer.overrideAssistantText('Rewritten');
      await settleCommittedSnapshot();

      expect(deltaCalls).toHaveLength(0);
      expect(liveCalls).toHaveLength(2);
      expect(liveCalls[1]).toMatchObject({
        body: { type: 'message', message: 'Rewritten' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets to a full snapshot after the ephemeral connection epoch changes (socket reconnect)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls, deltaCalls, bumpConnectionEpoch } = createDeltaSessionStub();
      const writer = createDeltaWriter(session);

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();
      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' world');
      await settleCommittedSnapshot();
      expect(deltaCalls).toHaveLength(1);
      expect(liveCalls).toHaveLength(1);

      bumpConnectionEpoch();
      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta('!');
      await settleCommittedSnapshot();

      expect(deltaCalls).toHaveLength(1);
      expect(liveCalls).toHaveLength(2);
      expect(liveCalls[1]).toMatchObject({
        body: { type: 'message', message: 'Hello world!' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends segments with a full snapshot (never a delta) on flushAll state transitions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls, deltaCalls, durableCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session);

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();
      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' world');
      await settleCommittedSnapshot();
      expect(deltaCalls).toHaveLength(1);

      await writer.flushAll({ reason: 'turn-end' });
      await settleCommittedSnapshot();

      expect(deltaCalls).toHaveLength(1);
      const lastLive = liveCalls[liveCalls.length - 1]!;
      expect(lastLive).toMatchObject({
        body: { type: 'message', message: 'Hello world' },
      });
      expect(lastLive.meta).toMatchObject({
        happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
      });
      expect(durableCalls[durableCalls.length - 1]).toMatchObject({
        body: { type: 'message', message: 'Hello world' },
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps emitting full snapshots when the session does not support deltas', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls } = createSessionStub({ withLive: true });
      const writer = createDeltaWriter(session);

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();
      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' world');
      await settleCommittedSnapshot();

      expect(liveCalls).toHaveLength(2);
      expect(liveCalls[1]).toMatchObject({
        body: { type: 'message', message: 'Hello world' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables deltas entirely when the live checkpoint interval is zero (snapshot-only mode)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls, deltaCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session, { liveCheckpointIntervalMs: 0 });

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();
      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' world');
      await settleCommittedSnapshot();

      expect(deltaCalls).toHaveLength(0);
      expect(liveCalls).toHaveLength(2);
      expect(liveCalls[1]).toMatchObject({
        body: { type: 'message', message: 'Hello world' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
