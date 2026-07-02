import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { createStreamedTranscriptWriter } from './createStreamedTranscriptWriter';

type DurableCall = {
  provider: string;
  localId: string;
  meta: Record<string, unknown> | undefined;
  body: unknown;
};

function createSessionStub() {
  const durableCalls: DurableCall[] = [];
  const bestEffortCalls: DurableCall[] = [];
  const liveCalls: Array<DurableCall & { createdAt: number; updatedAt: number }> = [];

  const session = {
    sendAgentMessage: (provider: any, body: any, opts: any) => {
      bestEffortCalls.push({
        provider: String(provider),
        localId: typeof opts?.localId === 'string' ? opts.localId : '',
        meta: opts?.meta,
        body,
      });
    },
    sendAgentMessageEphemeral: (provider: any, body: any, opts: any) => {
      liveCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts?.meta,
        body,
        createdAt: Number(opts.createdAt),
        updatedAt: Number(opts.updatedAt),
      });
    },
    sendAgentMessageCommitted: async (provider: any, body: any, opts: any) => {
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
  await Promise.resolve();
  await Promise.resolve();
}

describe('createStreamedTranscriptWriter', () => {
  it('defers durable checkpoints until durable commits are explicitly enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls, liveCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'opencode' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      durableCommitsRequireExplicitEnable: true,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    writer.appendAssistantDelta('Internal until classified');
    await settleCommittedSnapshot();

    expect(liveCalls).toHaveLength(1);
    expect(durableCalls).toHaveLength(0);

    writer.enableDurableCommits();
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: 'opencode',
      localId: 'segment-1',
      body: { type: 'message', message: 'Internal until classified' },
    });
  });

  it('discards unconfirmed streamed segments before final flush persists them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'opencode' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      durableCommitsRequireExplicitEnable: true,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Compaction summary');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(0);

    writer.discard();
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(0);
  });

  it('uses the durable enqueue hook instead of direct committed sends when the hook exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls, bestEffortCalls } = createSessionStub();
    const enqueueAgentMessageCommitted = vi.fn(async (provider: any, body: any, opts: any) => ({
      persisted: true as const,
      delivered: false,
      provider,
      body,
      opts,
    }));
    (session as any).enqueueAgentMessageCommitted = enqueueAgentMessageCommitted;

    const writer = createStreamedTranscriptWriter({
      provider: 'opencode' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Queued durable snapshot');
    const summary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'Queued durable snapshot' },
      expect.objectContaining({ localId: 'segment-1' }),
    );
    expect(durableCalls).toHaveLength(0);
    expect(bestEffortCalls).toHaveLength(0);
    expect(summary.assistant.didDurablyFlush).toBe(true);
    expect(summary.assistantRoot.didDurablyFlush).toBe(true);
  });

  it('does not advance durable checkpoints when the durable enqueue hook drops persistence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session } = createSessionStub();
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: false as const,
      delivered: false,
    }));
    (session as any).enqueueAgentMessageCommitted = enqueueAgentMessageCommitted;

    const writer = createStreamedTranscriptWriter({
      provider: 'opencode' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Dropped durable snapshot');
    const summary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledOnce();
    expect(summary.assistant.didDurablyFlush).toBe(false);
    expect(summary.assistantRoot.didDurablyFlush).toBe(false);
  });

  it('emits live snapshots ahead of durable checkpoints and flushes the latest text on the live cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls, liveCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
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
      provider: 'codex',
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
      provider: 'codex',
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

  it('publishes live override snapshots immediately so final corrections do not wait for durable checkpoints', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, liveCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 5_000,
      liveSnapshotMinChars: 999,
    });

    writer.appendAssistantDelta('READY ');
    await settleCommittedSnapshot();

    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0]!.body).toMatchObject({ type: 'message', message: 'READY ' });

    writer.overrideAssistantText('READY_FOR_FOLLOWUP');
    await settleCommittedSnapshot();

    expect(liveCalls).toHaveLength(2);
    expect(liveCalls[1]!.body).toMatchObject({ type: 'message', message: 'READY_FOR_FOLLOWUP' });
    expect(liveCalls[1]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'streaming' }),
    });
  });

  it('delays the first durable checkpoint until the configured initial checkpoint delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls, liveCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
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

    vi.advanceTimersByTime(1);
    await vi.runOnlyPendingTimersAsync();
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: 'codex',
      localId: 'l1',
      body: { type: 'message', message: 'Hello' },
    });
  });

  it('emits durable checkpoints on the configured interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'l1',
      initialCheckpointDelayMs: 0,
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
      provider: 'codex',
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
      provider: 'codex',
      localId: 'l1',
      body: { type: 'message', message: 'Hello world!?' },
    });
  });

  it('emits a scheduled durable checkpoint after the interval even without another delta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'l1',
      initialCheckpointDelayMs: 10,
      checkpointIntervalMs: 50,
      checkpointMinChars: 256,
    });

    writer.appendAssistantDelta('Hello');
    await vi.advanceTimersByTimeAsync(10);
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);

    writer.appendAssistantDelta(' world');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(49);
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]).toMatchObject({
      provider: 'codex',
      localId: 'l1',
      body: { type: 'message', message: 'Hello world' },
    });
  });

  it('writes durable checkpoints by reusing the segment localId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const ids = ['segment-1'];

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => ids.shift() ?? 'missing',
      initialCheckpointDelayMs: 0,
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: 'codex',
      localId: 'segment-1',
      body: { type: 'message', message: 'Hello' },
    });

    writer.appendAssistantDelta(' world');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]).toMatchObject({
      provider: 'codex',
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => ids.shift() ?? 'missing',
      initialCheckpointDelayMs: 0,
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'l1',
      initialCheckpointDelayMs: 0,
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
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

  it('does not create a new durable segment when overrideAssistantText is called before any streamed delta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    const flushSummary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(flushSummary as any).toMatchObject({
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello from sidechain', { sidechainId: 'sc-1' });
    const flushSummary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(flushSummary as any).toMatchObject({
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'l1',
      initialCheckpointDelayMs: 0,
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    const flushSummary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(bestEffortCalls).toHaveLength(0);
    expect(flushSummary as any).toMatchObject({
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'l1',
      initialCheckpointDelayMs: 0,
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 100,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    // Append some content to create a segment
    writer.appendAssistantDelta('Hello world');
    await Promise.resolve();

    expect(durableCalls).toHaveLength(0);

    // Call flushAll twice in quick succession (simulating abort followed by turn-end)
    await Promise.all([
      writer.flushAll({ reason: 'abort', interruptedReason: 'cancelled' }),
      writer.flushAll({ reason: 'turn-end' }),
    ]);

    expect(durableCalls).toHaveLength(1);

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
    session.sendAgentMessageCommitted = vi.fn(async (provider: any, body: any, opts: any) => {
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
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

  it('tracks an in-flight durable commit and drains it before flushAll resolves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    let resolveFirstCommit: (() => void) | undefined;
    session.sendAgentMessageCommitted = vi.fn(async (provider: any, body: any, opts: any) => {
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
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
        provider: 'codex' as any,
        session: session as any,
        makeLocalId: () => 'segment-secret',
        initialCheckpointDelayMs: 0,
        checkpointIntervalMs: 1_000,
        checkpointMinChars: 1,
      });

      writer.appendAssistantDelta('Hello');
      await Promise.resolve();
      await Promise.resolve();

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
