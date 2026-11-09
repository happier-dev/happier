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
    enqueueAgentMessageCommitted: async (provider: any, body: any, opts: any) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
      return { persisted: true as const, delivered: false as const };
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

  it('does not advance durable checkpoints when the durable enqueue hook rejects custody', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session } = createSessionStub();
    const enqueueAgentMessageCommitted = vi.fn(async () => {
      throw new Error('durable custody rejected');
    });
    const sessionWithDurableEnqueue = {
      ...session,
      enqueueAgentMessageCommitted,
    };

    const writer = createStreamedTranscriptWriter({
      provider: 'opencode',
      session: sessionWithDurableEnqueue,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Rejected durable snapshot');
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

  it('reports an incomplete durable final turn flush without a durable enqueue API', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, bestEffortCalls } = createSessionStub();
    const sessionWithoutDurableEnqueue = {
      ...session,
      enqueueAgentMessageCommitted: undefined,
    };
    sessionWithoutDurableEnqueue.sendAgentMessageCommitted = vi.fn(async () => undefined);

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: sessionWithoutDurableEnqueue as any,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Hello');
    const flushSummary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(bestEffortCalls).toHaveLength(0);
    expect(sessionWithoutDurableEnqueue.sendAgentMessageCommitted).not.toHaveBeenCalled();
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

    session.enqueueAgentMessageCommitted = async () => {
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
    session.enqueueAgentMessageCommitted = vi.fn(async (provider: any, body: any, opts: any) => {
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
      return { persisted: true as const, delivered: false as const };
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

  it('redacts durable commit errors before logging', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const secretError = new Error(
      'commit failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/messages?token=secret Authorization: Bearer COMMIT_SECRET',
    );
    secretError.stack = `${secretError.name}: ${secretError.message}\n    at durableCommit (stream-writer.test:1:1)`;
    const session = {
      enqueueAgentMessageCommitted: vi.fn(async () => {
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
          message: expect.stringContaining('commit failed for https://api.example.test/v1/messages'),
          stack: expect.stringContaining('at durableCommit (stream-writer.test:1:1)'),
        }),
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('COMMIT_SECRET');
      expect(JSON.stringify(logged)).not.toContain('alice');
      expect(session.sendAgentMessage).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('coalesces fast durable failures into the latest segment snapshot and one failure incident', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const enqueueAgentMessageCommitted = vi.fn()
      .mockRejectedValueOnce(new Error('Socket not connected'))
      .mockRejectedValueOnce(new Error('Socket not connected'))
      .mockResolvedValue({ persisted: true as const, delivered: false as const });

    try {
      const writer = createStreamedTranscriptWriter({
        provider: 'codex' as any,
        session: { enqueueAgentMessageCommitted } as any,
        makeLocalId: () => 'offline-segment-1',
        initialCheckpointDelayMs: 0,
        checkpointIntervalMs: 0,
        checkpointMinChars: 1,
      });

      writer.appendAssistantDelta('a');
      await settleCommittedSnapshot();
      writer.appendAssistantDelta('b');
      await settleCommittedSnapshot();
      writer.appendAssistantDelta('c');
      await settleCommittedSnapshot();

      expect(enqueueAgentMessageCommitted).toHaveBeenCalledOnce();
      expect(debugSpy.mock.calls.filter(([message]) =>
        message === '[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)'
      )).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await settleCommittedSnapshot();
      expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(2);
      expect(enqueueAgentMessageCommitted.mock.calls[1]?.[1]).toEqual({ type: 'message', message: 'abc' });

      await vi.advanceTimersByTimeAsync(2_000);
      await settleCommittedSnapshot();
      expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(3);
      expect(debugSpy.mock.calls.filter(([message]) =>
        message === '[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)'
      )).toHaveLength(1);
      expect(debugSpy).toHaveBeenCalledWith(
        '[StreamedTranscriptWriter] Durable snapshot commit recovered',
        expect.objectContaining({ failureCount: 2, suppressedFailureCount: 1 }),
      );
    } finally {
      debugSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not delay a terminal durable snapshot behind streaming failure backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const enqueueAgentMessageCommitted = vi.fn()
      .mockRejectedValueOnce(new Error('Socket not connected'))
      .mockResolvedValue({ persisted: true as const, delivered: false as const });

    try {
      const writer = createStreamedTranscriptWriter({
        provider: 'codex' as any,
        session: { enqueueAgentMessageCommitted } as any,
        makeLocalId: () => 'terminal-offline-segment-1',
        initialCheckpointDelayMs: 0,
        checkpointIntervalMs: 0,
        checkpointMinChars: 1,
      });

      writer.appendAssistantDelta('partial');
      await settleCommittedSnapshot();
      writer.appendAssistantDelta(' complete');

      await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
        assistantRoot: { sawText: true, didDurablyFlush: true },
      });
      expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(2);
      expect(enqueueAgentMessageCommitted.mock.calls[1]?.[1]).toEqual({
        type: 'message',
        message: 'partial complete',
      });
      expect(enqueueAgentMessageCommitted.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
        }),
      }));
    } finally {
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
    enqueueAgentMessageCommitted: async (provider: any, body: any, opts: any) => {
      durableCalls.push({
        provider: String(provider),
        localId: String(opts.localId),
        meta: opts.meta,
        body,
      });
      return { persisted: true as const, delivered: false as const };
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

describe('createStreamedTranscriptWriter wire bytes per frame', () => {
  it('keeps live and durable frame text flat while a long message grows, and both chains rebuild the exact text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const liveFrames: Array<{ kind: 'snapshot' | 'delta'; text: string; baseLength?: number; state: unknown }> = [];
      const durableFrames: Array<{ full: string; append?: { text: string; baseLength: number; baseUpdatedAt: number; length: number }; updatedAtMs: number }> = [];
      const readText = (body: any) => String(body?.message ?? body?.text ?? '');
      const readSegment = (meta: any) => meta?.happierStreamSegmentV1 ?? {};
      const session = {
        sendAgentMessageEphemeral: (_provider: any, body: any, opts: any) => {
          liveFrames.push({ kind: 'snapshot', text: readText(body), state: readSegment(opts.meta).segmentState });
          return { accepted: true as const, epoch: 1 };
        },
        sendAgentMessageEphemeralDelta: (_provider: any, body: any, opts: any) => {
          liveFrames.push({ kind: 'delta', text: readText(body), baseLength: opts.baseLength, state: readSegment(opts.meta).segmentState });
          return { accepted: true as const, epoch: 1 };
        },
        getEphemeralStreamConnectionEpoch: () => 1,
        enqueueAgentMessageCommitted: async (_provider: any, body: any, opts: any) => {
          durableFrames.push({
            full: readText(body),
            ...(opts.append ? { append: { text: readText(opts.append.body), baseLength: opts.append.baseLength, baseUpdatedAt: opts.append.baseUpdatedAt, length: opts.append.length } } : {}),
            updatedAtMs: readSegment(opts.meta).updatedAtMs,
          });
          return { persisted: true as const, delivered: true as const, committedSequence: durableFrames.length };
        },
      };
      const writer = createStreamedTranscriptWriter({
        provider: 'codex' as any,
        session: session as any,
        makeLocalId: () => 'segment-1',
        initialCheckpointDelayMs: 500,
        checkpointIntervalMs: 2_000,
        checkpointMinChars: 256,
        liveSnapshotIntervalMs: 40,
        liveSnapshotMinChars: 1,
      });

      const lines = Array.from({ length: 400 }, (_, index) => `${String(index + 1).padStart(3, '0')} numbered line\n`);
      for (const line of lines) {
        writer.appendAssistantDelta(line);
        await settleCommittedSnapshot();
        vi.advanceTimersByTime(40);
        await settleCommittedSnapshot();
      }
      await writer.flushAll({ reason: 'turn-end' });
      const finalText = lines.join('');

      // Frames sent while the message is short vs long: what each frame carries must not grow with the message.
      const transmitted = (frame: { kind: string; text: string }) => frame.text.length;
      const liveEarly = liveFrames.slice(1, 60).map(transmitted);
      const liveLate = liveFrames.slice(-60).map(transmitted);
      const durableSent = durableFrames.map((frame) => frame.append ? frame.append.text.length : frame.full.length);
      const counts = {
        liveMaxEarly: Math.max(...liveEarly),
        liveMaxLate: Math.max(...liveLate),
        durableMaxEarly: Math.max(...durableSent.slice(1, 4)),
        durableMaxLate: Math.max(...durableSent.slice(-3)),
      };
      expect(counts.liveMaxLate).toBeLessThanOrEqual(counts.liveMaxEarly);
      expect(counts.durableMaxLate).toBeLessThanOrEqual(counts.durableMaxEarly * 2);
      expect(durableFrames.length).toBeGreaterThan(4);

      // Exactness: first snapshot + chained deltas rebuild the final text; each durable append names its acknowledged base.
      let live = '';
      for (const frame of liveFrames) {
        if (frame.kind === 'snapshot') live = frame.text;
        else { expect(frame.baseLength).toBe(live.length); live += frame.text; }
      }
      expect(live).toBe(finalText);
      let durable = '';
      let durableUpdatedAt = -1;
      for (const frame of durableFrames) {
        if (frame.append) {
          expect(frame.append.baseLength).toBe(durable.length);
          expect(frame.append.baseUpdatedAt).toBe(durableUpdatedAt);
          expect(frame.full).toBe(durable + frame.append.text);
          expect(frame.append.length).toBe(frame.full.length);
        }
        durable = frame.full;
        durableUpdatedAt = frame.updatedAtMs;
      }
      expect(durable).toBe(finalText);
      expect(durableFrames.slice(1).every((frame) => frame.append !== undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createStreamedTranscriptWriter rewrite generation', () => {
  it('bumps the text generation on a rewrite so receivers never splice text across it, and names no append across it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const generations: Array<{ channel: string; generation: unknown; append: boolean }> = [];
      const read = (meta: any) => meta?.happierStreamSegmentV1?.textGeneration;
      const session = {
        sendAgentMessageEphemeral: (_p: any, _b: any, opts: any) => { generations.push({ channel: 'snapshot', generation: read(opts.meta), append: false }); return { accepted: true as const, epoch: 1 }; },
        sendAgentMessageEphemeralDelta: (_p: any, _b: any, opts: any) => { generations.push({ channel: 'delta', generation: read(opts.meta), append: false }); return { accepted: true as const, epoch: 1 }; },
        getEphemeralStreamConnectionEpoch: () => 1,
        enqueueAgentMessageCommitted: async (_p: any, _b: any, opts: any) => {
          generations.push({ channel: 'durable', generation: read(opts.meta), append: opts.append !== undefined });
          return { persisted: true as const, delivered: true as const, committedSequence: 1 };
        },
      };
      const writer = createStreamedTranscriptWriter({
        provider: 'codex' as any, session: session as any, makeLocalId: () => 'segment-1',
        initialCheckpointDelayMs: 0, checkpointIntervalMs: 0, checkpointMinChars: 1, liveSnapshotIntervalMs: 0, liveSnapshotMinChars: 1,
      });
      writer.appendAssistantDelta('The answer is 42');
      await settleCommittedSnapshot(); await settleCommittedSnapshot();
      writer.overrideAssistantText('The answer: 41');
      await settleCommittedSnapshot(); await settleCommittedSnapshot();
      writer.appendAssistantDelta(' and more');
      await settleCommittedSnapshot(); await settleCommittedSnapshot();

      const rewriteAt = generations.findIndex((entry) => entry.channel === 'snapshot' && entry.generation === 1);
      expect(rewriteAt).toBeGreaterThan(0);
      expect(generations.slice(0, rewriteAt).every((entry) => (entry.generation ?? 0) === 0)).toBe(true);
      expect(generations.slice(rewriteAt).every((entry) => entry.generation === 1)).toBe(true);
      const firstDurableAfter = generations.slice(rewriteAt).find((entry) => entry.channel === 'durable');
      expect(firstDurableAfter).toMatchObject({ append: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

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

  it('keeps appending deltas however long the segment streams (no periodic full snapshot)', async () => {
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
      vi.advanceTimersByTime(5_000);
      writer.appendAssistantDelta('!');
      await settleCommittedSnapshot();

      expect(liveCalls).toHaveLength(1);
      expect(deltaCalls).toHaveLength(2);
      expect(deltaCalls[1]).toMatchObject({
        body: { type: 'message', message: '!' },
        tick: 3,
        baseLength: 11,
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

  it('ends an in-sync segment with a delta carrying the terminal state; the durable row keeps the full text', async () => {
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

      expect(liveCalls).toHaveLength(1);
      expect(deltaCalls).toHaveLength(2);
      const lastLive = deltaCalls[1]!;
      expect(lastLive).toMatchObject({
        body: { type: 'message', message: '' },
        tick: 3,
        baseLength: 11,
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

  it('disables deltas entirely when live deltas are off (snapshot-only mode)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { session, liveCalls, deltaCalls } = createDeltaSessionStub();
      const writer = createDeltaWriter(session, { liveDeltas: false });

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
      sendAgentMessageEphemeralDelta: vi.fn((_provider: unknown, body: unknown) => {
        order.push(`delta:${(body as { message: string }).message}`);
        return { accepted: true as const, epoch: 1 };
      }),
      enqueueAgentMessageCommitted: vi.fn(async (_provider: unknown, body: unknown) => {
        order.push(`durable:${(body as { message: string }).message}`);
        return { persisted: true as const, delivered: false as const };
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

    expect(liveBodies).toEqual([{ type: 'message', message: 'a' }]);
    expect(order).toEqual(['live:a', 'delta:bc', 'durable:abc']);
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
      enqueueAgentMessageCommitted: vi.fn(async (_provider: unknown, body: unknown, opts: { localId: string }) => {
        durableCalls.push({ localId: opts.localId, body });
        return { persisted: true as const, delivered: false as const };
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
