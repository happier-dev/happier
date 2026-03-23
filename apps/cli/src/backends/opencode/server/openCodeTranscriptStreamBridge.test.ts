import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeTranscriptStreamBridge } from './openCodeTranscriptStreamBridge';

async function flushTranscriptCommitMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createSessionStub() {
  const draftCalls: Array<Record<string, unknown>> = [];
  const durableCalls: Array<Record<string, unknown>> = [];
  const bestEffortCalls: Array<Record<string, unknown>> = [];

  const session = {
    sendTranscriptDraftDelta: (provider: unknown, params: Record<string, unknown>) => {
      draftCalls.push({ provider, ...params });
    },
    sendAgentMessageCommitted: async (provider: unknown, body: unknown, opts: Record<string, unknown>) => {
      durableCalls.push({ provider, body, ...opts });
    },
    sendAgentMessage: (provider: unknown, body: unknown, opts: Record<string, unknown>) => {
      bestEffortCalls.push({ provider, body, ...opts });
    },
  };

  return { session, draftCalls, durableCalls, bestEffortCalls };
}

describe('createOpenCodeTranscriptStreamBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('streams assistant deltas as draft updates while durable checkpoints reuse the segment localId', async () => {
    const { session, draftCalls, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
      draftFlushIntervalMs: 0,
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
    bridge.flushAll({ reason: 'turn-end' });
    await flushTranscriptCommitMicrotasks();

    expect(draftCalls.map((row) => row.deltaText)).toEqual(['Hello', '.']);
    expect(draftCalls[0]?.localId).toBeTruthy();
    expect(draftCalls[1]?.localId).toBe(draftCalls[0]?.localId);

    expect(durableCalls.map((row) => (row.body as any)?.message)).toEqual(['Hello', 'Hello.']);
    expect(durableCalls[0]?.localId).toBe(draftCalls[0]?.localId);
    expect(durableCalls[1]?.localId).toBe(draftCalls[0]?.localId);
    expect((durableCalls[0]?.meta as any)?.happierStreamKey).toBe('stream-1');
    expect((durableCalls[1]?.meta as any)?.happierStreamSegmentV1).toMatchObject({
      segmentKind: 'assistant',
      segmentLocalId: draftCalls[0]?.localId,
      segmentState: 'complete',
    });
  });

  it('preserves sidechain metadata and completion state on sidechain assistant streams', async () => {
    const { session, durableCalls } = createSessionStub();
    const bridge = createOpenCodeTranscriptStreamBridge({
      provider: 'opencode' as any,
      session: session as any,
      draftFlushIntervalMs: 0,
    });

    bridge.appendAssistantDelta({
      deltaText: 'CHILD_OK',
      streamKey: 'stream-child',
      remoteSessionId: 'ses_child_1',
      messageId: 'msg_child_1',
      sidechainId: 'call_task_1',
    });
    bridge.flushAll({ reason: 'turn-end' });
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
