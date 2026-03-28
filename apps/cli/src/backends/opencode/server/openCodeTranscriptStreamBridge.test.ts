import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeTranscriptStreamBridge } from './openCodeTranscriptStreamBridge';

async function flushTranscriptCommitMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createSessionStub() {
  const durableCalls: Array<Record<string, unknown>> = [];
  const bestEffortCalls: Array<Record<string, unknown>> = [];

  const session = {
    sendAgentMessageCommitted: async (provider: unknown, body: unknown, opts: Record<string, unknown>) => {
      durableCalls.push({ provider, body, ...opts });
    },
    sendAgentMessage: (provider: unknown, body: unknown, opts: Record<string, unknown>) => {
      bestEffortCalls.push({ provider, body, ...opts });
    },
  };

  return { session, durableCalls, bestEffortCalls };
}

describe('createOpenCodeTranscriptStreamBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('streams assistant deltas via durable checkpoints that reuse the segment localId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
    });

    bridge.appendAssistantDelta({
      deltaText: 'Hello',
      streamKey: 'stream-1',
      remoteSessionId: 'ses_1',
      messageId: 'msg_1',
      sidechainId: null,
    });
    bridge.appendAssistantDelta({
      deltaText: '.',
      streamKey: 'stream-1',
      remoteSessionId: 'ses_1',
      messageId: 'msg_1',
      sidechainId: null,
    });
    await bridge.flushAll({ reason: 'turn-end' });
    await flushTranscriptCommitMicrotasks();

    expect(durableCalls.map((row) => (row.body as any)?.message)).toEqual(['Hello', 'Hello.']);
    expect(durableCalls[0]?.localId).toBeTruthy();
    expect(durableCalls[1]?.localId).toBe(durableCalls[0]?.localId);
    expect((durableCalls[0]?.meta as any)?.happierStreamKey).toBe('stream-1');
    expect((durableCalls[1]?.meta as any)?.happierStreamSegmentV1).toMatchObject({
      segmentKind: 'assistant',
      segmentLocalId: durableCalls[0]?.localId,
      segmentState: 'complete',
    });
  });

  it('preserves sidechain metadata and completion state on sidechain assistant streams', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { session, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
    });

    bridge.appendAssistantDelta({
      deltaText: 'CHILD_OK',
      streamKey: 'stream-child',
      remoteSessionId: 'ses_child_1',
      messageId: 'msg_child_1',
      sidechainId: 'call_task_1',
    });
    await bridge.flushAll({ reason: 'turn-end' });
    await flushTranscriptCommitMicrotasks();

    const finalCall = durableCalls[durableCalls.length - 1]!;
    expect((finalCall.body as any)).toMatchObject({ type: 'message', message: 'CHILD_OK', sidechainId: 'call_task_1' });
    expect(finalCall.meta).toMatchObject({
      happierStreamKey: 'stream-child',
      importedFrom: 'acp-sidechain',
      remoteSessionId: 'ses_child_1',
      sidechainId: 'call_task_1',
      happierSidechainStreamKey: 'stream-child',
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });
});
