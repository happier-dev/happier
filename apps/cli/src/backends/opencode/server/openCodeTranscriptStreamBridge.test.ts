import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createOpenCodeTranscriptStreamBridge } from './openCodeTranscriptStreamBridge';
import { createOpenCodeTranscriptStreamSession } from './createOpenCodeTranscriptStreamSession';

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

  it('forwards ephemeral stream snapshots with the same sidechain metadata as durable sends', () => {
    const ephemeralCalls: Array<{
      provider: ACPProvider;
      body: ACPMessageData;
      opts: {
        localId: string;
        createdAt: number;
        updatedAt?: number;
        meta?: Record<string, unknown>;
      };
    }> = [];

    const session = createOpenCodeTranscriptStreamSession({
      baseMeta: {
        happierStreamKey: 'stream-child',
        importedFrom: 'acp-sidechain',
        remoteSessionId: 'ses_child_1',
        sidechainId: 'call_task_1',
        happierSidechainStreamKey: 'stream-child',
      },
      session: {
        sendAgentMessageCommitted: async () => {},
        sendAgentMessage: () => {},
        sendAgentMessageEphemeral: (provider, body, opts) => {
          ephemeralCalls.push({ provider, body, opts });
        },
      },
    });

    expect(session.sendAgentMessageEphemeral).toBeTypeOf('function');

    session.sendAgentMessageEphemeral?.(
      'opencode',
      { type: 'message', message: 'CHILD_OK', sidechainId: 'call_task_1' },
      {
        localId: 'segment-1',
        createdAt: 10,
        updatedAt: 20,
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'segment-1',
            segmentState: 'streaming',
            updatedAtMs: 20,
          },
        },
      },
    );

    expect(ephemeralCalls).toEqual([
      {
        provider: 'opencode',
        body: { type: 'message', message: 'CHILD_OK', sidechainId: 'call_task_1' },
        opts: {
          localId: 'segment-1',
          createdAt: 10,
          updatedAt: 20,
          meta: {
            happierStreamKey: 'stream-child',
            importedFrom: 'acp-sidechain',
            remoteSessionId: 'ses_child_1',
            sidechainId: 'call_task_1',
            happierSidechainStreamKey: 'stream-child',
            happierStreamSegmentV1: {
              v: 1,
              segmentKind: 'assistant',
              segmentLocalId: 'segment-1',
              segmentState: 'streaming',
              updatedAtMs: 20,
            },
          },
        },
      },
    ]);
  });
});
