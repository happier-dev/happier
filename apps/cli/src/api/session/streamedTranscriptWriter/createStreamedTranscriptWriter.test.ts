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
      return { accepted: true as const, epoch: 0 };
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

    await flushPromise;

    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(didResolveFlush).toBe(true);
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

    // Call flushAll twice in quick succession for the same terminal settlement.
    await Promise.all([
      writer.flushAll({ reason: 'turn-end' }),
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
  const liveCalls: Array<DurableCall & { createdAt: number; updatedAt: number; tick?: number }> = [];
  const deltaCalls: LiveDeltaCall[] = [];
  const durableCalls: DurableCall[] = [];
  let connectionEpoch = 1;

  const session = {
    sendAgentMessageCommitted: async (provider: any, body: any, opts: any) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
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
        ...(typeof opts.tick === 'number' ? { tick: opts.tick } : {}),
      });
      return { accepted: true as const, epoch: connectionEpoch };
    },
    sendAgentMessageEphemeralDelta: (provider: any, body: any, opts: any) => {
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
  function createDeltaWriter(session: unknown, overrides: Record<string, unknown> = {}) {
    return createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
      liveCheckpointIntervalMs: 1_000,
      ...overrides,
    });
  }

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
      expect(liveCalls[0]!.tick).toBe(1);

      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' wor');
      await settleCommittedSnapshot();

      expect(liveCalls).toHaveLength(1);
      expect(deltaCalls).toHaveLength(1);
      expect(deltaCalls[0]).toMatchObject({
        provider: 'codex',
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

  it('avoids prefix scans on append-only live delta checks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const originalStartsWith = String.prototype.startsWith;
    const startsWithSpy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function startsWith(this: string, searchString: string, position?: number) {
      return originalStartsWith.call(this, searchString, position);
    });
    try {
      const { session, deltaCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session, {
        durableCommitsRequireExplicitEnable: true,
      });

      writer.appendAssistantDelta('Hello');
      await settleCommittedSnapshot();
      startsWithSpy.mockClear();

      vi.advanceTimersByTime(40);
      writer.appendAssistantDelta(' world');
      await settleCommittedSnapshot();

      expect(deltaCalls).toHaveLength(1);
      expect(startsWithSpy).not.toHaveBeenCalled();
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
      expect(liveCalls[1]!.tick).toBe(3);

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
      const { session, liveCalls } = createSessionStub();
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

  it.each(['sync', 'async'] as const)('does not advance its baseline after a %s local send failure', async (failureMode) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const snapshotBodies: unknown[] = [];
    let attempts = 0;
    const session = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      getEphemeralStreamConnectionEpoch: () => 1,
      sendAgentMessageEphemeral: vi.fn((_provider: unknown, body: unknown) => {
        attempts += 1;
        if (attempts === 1) {
          if (failureMode === 'sync') {
            throw new Error('sync failure');
          }
          return Promise.resolve({
            accepted: false as const,
            epoch: 1,
            reason: 'emit_failed' as const,
          });
        }
        snapshotBodies.push(body);
        return { accepted: true as const, epoch: 1 };
      }),
      sendAgentMessageEphemeralDelta: vi.fn(() => ({ accepted: true as const, epoch: 1 })),
    };

    try {
      const writer = createDeltaWriter(session, { liveSnapshotIntervalMs: 0 });
      writer.appendAssistantDelta('hello');
      await settleCommittedSnapshot();
      writer.appendAssistantDelta(' world');
      await settleCommittedSnapshot();

      expect(session.sendAgentMessageEphemeralDelta).not.toHaveBeenCalled();
      expect(snapshotBodies).toEqual([{ type: 'message', message: 'hello world' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces updates while one publication is in flight and drains terminal live state before durable commit', async () => {
    let resolveFirst!: (outcome: { accepted: true; epoch: number }) => void;
    const order: string[] = [];
    const liveBodies: unknown[] = [];
    const session = {
      getEphemeralStreamConnectionEpoch: () => 1,
      sendAgentMessageEphemeral: vi.fn(async (_provider: unknown, body: unknown) => {
        liveBodies.push(body);
        order.push(`live:${(body as { message: string }).message}`);
        if (liveBodies.length === 1) {
          return await new Promise<{ accepted: true; epoch: number }>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { accepted: true as const, epoch: 1 };
      }),
      sendAgentMessageEphemeralDelta: vi.fn(() => ({ accepted: true as const, epoch: 1 })),
      sendAgentMessageCommitted: vi.fn(async (_provider: unknown, body: unknown) => {
        order.push(`durable:${(body as { message: string }).message}`);
      }),
    };
    const writer = createDeltaWriter(session, { liveSnapshotIntervalMs: 0 });

    writer.appendAssistantDelta('a');
    writer.appendAssistantDelta('b');
    writer.appendAssistantDelta('c');
    const flush = writer.flushAll({ reason: 'turn-end' });
    await Promise.resolve();

    expect(liveBodies).toEqual([{ type: 'message', message: 'a' }]);
    expect(order.some((entry) => entry.startsWith('durable:'))).toBe(false);

    resolveFirst({ accepted: true, epoch: 1 });
    await flush;

    expect(liveBodies).toEqual([
      { type: 'message', message: 'a' },
      { type: 'message', message: 'abc' },
    ]);
    expect(order).toEqual(['live:a', 'live:abc', 'durable:abc']);
  });

  it('starts a successor segment while the prior terminal live publication is draining', async () => {
    let resolveFirst!: (outcome: { accepted: true; epoch: number }) => void;
    let nextLocalId = 0;
    const durableCalls: Array<{ localId: string; body: unknown }> = [];
    const session = {
      getEphemeralStreamConnectionEpoch: () => 1,
      sendAgentMessageEphemeral: vi.fn(async () => {
        if (resolveFirst === undefined) {
          return await new Promise<{ accepted: true; epoch: number }>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { accepted: true as const, epoch: 1 };
      }),
      sendAgentMessageCommitted: vi.fn(async (_provider: unknown, body: unknown, opts: { localId: string }) => {
        durableCalls.push({ localId: opts.localId, body });
      }),
    };
    const writer = createDeltaWriter(session, {
      liveSnapshotIntervalMs: 0,
      makeLocalId: () => `segment-${++nextLocalId}`,
    });

    writer.appendAssistantDelta('First answer');
    const firstFlush = writer.flushAll({ reason: 'turn-end' });
    writer.appendAssistantDelta('Second answer');

    resolveFirst({ accepted: true, epoch: 1 });
    await firstFlush;
    await writer.flushAll({ reason: 'turn-end' });

    expect(durableCalls).toEqual([
      { localId: 'segment-1', body: { type: 'message', message: 'First answer' } },
      { localId: 'segment-2', body: { type: 'message', message: 'Second answer' } },
    ]);
  });
});
