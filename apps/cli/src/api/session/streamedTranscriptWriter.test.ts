import { describe, expect, it, vi } from 'vitest';

import { createStreamedTranscriptWriter } from './streamedTranscriptWriter';

type DurableCall = {
  provider: string;
  localId: string;
  meta: Record<string, unknown> | undefined;
  body: unknown;
};

function createSessionStub() {
  const durableCalls: DurableCall[] = [];
  const bestEffortCalls: DurableCall[] = [];

  const session = {
    sendAgentMessage: (provider: any, body: any, opts: any) => {
      bestEffortCalls.push({
        provider: String(provider),
        localId: typeof opts?.localId === 'string' ? opts.localId : '',
        meta: opts?.meta,
        body,
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

  return { session, durableCalls, bestEffortCalls };
}

async function settleCommittedSnapshot() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createStreamedTranscriptWriter', () => {
  it('emits durable checkpoints on the configured interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
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

    vi.advanceTimersByTime(49);
    await settleCommittedSnapshot();
    writer.appendAssistantDelta('!');
    await settleCommittedSnapshot();
    expect(durableCalls).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await settleCommittedSnapshot();
    writer.appendAssistantDelta('?');
    await settleCommittedSnapshot();

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]).toMatchObject({
      provider: 'codex',
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
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => ids.shift() ?? 'missing',
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await Promise.resolve();

    expect(durableCalls).toHaveLength(1);

    vi.setSystemTime(new Date(1_000));
    writer.appendAssistantDelta(' world');
    await Promise.resolve();

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
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    const didOverride = writer.overrideAssistantText('FINAL');
    await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(didOverride).toBe(false);
    expect(durableCalls).toHaveLength(0);
  });

  it('falls back to best-effort commits when sendAgentMessageCommitted fails', async () => {
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
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await Promise.resolve();

    expect(bestEffortCalls).toHaveLength(1);
    expect(bestEffortCalls[0]).toMatchObject({
      provider: 'codex',
      localId: 'l1',
      body: { type: 'message', message: 'Hello' },
    });
    expect(bestEffortCalls[0]!.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentKind: 'assistant', segmentState: 'streaming' }),
    });
  });

  it('does not resolve flushAll until the fallback best-effort commit finishes after a durable commit failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, bestEffortCalls } = createSessionStub();
    let resolveFallback: (() => void) | undefined;
    let fallbackPersisted = false;

    session.sendAgentMessageCommitted = async () => {
      throw new Error('boom');
    };
    session.sendAgentMessage = vi.fn(async (provider: any, body: any, opts: any) => {
      bestEffortCalls.push({
        provider: String(provider),
        localId: typeof opts?.localId === 'string' ? opts.localId : '',
        meta: opts?.meta,
        body,
      });
      await new Promise<void>((resolve) => {
        resolveFallback = () => {
          fallbackPersisted = true;
          resolve();
        };
      });
    });

    const writer = createStreamedTranscriptWriter({
      provider: 'codex' as any,
      session: session as any,
      makeLocalId: () => 'l1',
      checkpointIntervalMs: 1_000,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('Hello');
    await Promise.resolve();

    let didResolveFlush = false;
    const flushPromise = writer.flushAll({ reason: 'turn-end' }).then(() => {
      didResolveFlush = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(bestEffortCalls).toHaveLength(2);
    expect(fallbackPersisted).toBe(false);
    expect(didResolveFlush).toBe(false);

    const releaseFallback = resolveFallback;
    if (!releaseFallback) {
      throw new Error('expected fallback resolver');
    }
    releaseFallback();
    await flushPromise;

    expect(fallbackPersisted).toBe(true);
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
});
