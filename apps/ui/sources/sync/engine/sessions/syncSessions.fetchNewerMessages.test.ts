import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { fetchAndApplyNewerMessages } from './syncSessions';

function buildApiMessage(id: string, seq: number): ApiMessage {
    return {
        id,
        seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'encrypted',
            c: `encrypted-${id}`,
        },
        createdAt: 1_000 + seq,
        updatedAt: 2_000 + seq,
    };
}

describe('fetchAndApplyNewerMessages', () => {
  it('emits lifecycle events from ACP messages even when they do not normalize into visible transcript rows', async () => {
        const applyMessages = vi.fn();
        const onTaskLifecycleEvent = vi.fn();
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [buildApiMessage('m1', 2)],
                nextAfterSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const decryptMessages = vi.fn(async () => [
            {
                id: 'm1',
                localId: null,
                createdAt: 1_002,
                content: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'kimi',
                        data: { type: 'turn_aborted', id: 'task-1' },
                    },
                },
            },
        ]);

        await fetchAndApplyNewerMessages({
            sessionId: 's1',
            afterSeq: 1,
            limit: 150,
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(onTaskLifecycleEvent).toHaveBeenCalledWith({
            type: 'turn_aborted',
            id: 'task-1',
            createdAt: 1_002,
        });
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
  });

  it('passes the transcript seq through to normalized messages when available', async () => {
    const applyMessages = vi.fn();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [buildApiMessage('m1', 2)],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const decryptMessages = vi.fn(async () => [
      {
        id: 'm1',
        seq: 2,
        localId: null,
        createdAt: 1_002,
        content: {
          role: 'user',
          content: { type: 'text', text: 'hello' },
        },
      },
    ]);

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: () => ({ decryptMessages }),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log: { log: () => {} },
    });

    const normalized = applyMessages.mock.calls[0]?.[1]?.[0] as any;
    expect(normalized?.seq).toBe(2);
  });

  it('calls onNormalizedMessages with the normalized messages before applying them', async () => {
    const applyMessages = vi.fn();
    const onNormalizedMessages = vi.fn();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [buildApiMessage('m1', 2)],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const decryptMessages = vi.fn(async () => [
      {
        id: 'm1',
        seq: 2,
        localId: null,
        createdAt: 1_002,
        content: {
          role: 'user',
          content: { type: 'text', text: 'hello' },
        },
      },
    ]);

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: () => ({ decryptMessages }),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      onNormalizedMessages,
      log: { log: () => {} },
    } as any);

    expect(onNormalizedMessages).toHaveBeenCalledTimes(1);
    expect(onNormalizedMessages.mock.calls[0]?.[0]?.[0]?.id).toBe('m1');
    expect(applyMessages).toHaveBeenCalledWith('s1', expect.any(Array));
  });
});
