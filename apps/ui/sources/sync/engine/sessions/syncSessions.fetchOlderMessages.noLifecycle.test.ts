import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { fetchAndApplyOlderMessages } from './syncSessions';

function buildApiMessage(id: string, seq: number): ApiMessage {
  return {
    id,
    seq,
    localId: null,
    content: {
      t: 'encrypted',
      c: `encrypted-${id}`,
    },
    createdAt: 1_000 + seq,
  };
}

describe('fetchAndApplyOlderMessages', () => {
  it('does not emit lifecycle events from older pages', async () => {
    const applyMessages = vi.fn();
    const onTaskLifecycleEvent = vi.fn();
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          messages: [buildApiMessage('m1', 2)],
          hasMore: false,
          nextBeforeSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

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
            data: { type: 'task_complete', id: 'task-1' },
          },
        },
      },
    ]);

    await fetchAndApplyOlderMessages({
      sessionId: 's1',
      beforeSeq: 10,
      limit: 150,
      getSessionEncryption: () => ({ decryptMessages }),
      request,
      sessionReceivedMessages: new Map(),
      applyMessages,
      onTaskLifecycleEvent,
      log: { log: () => {} },
    });

    expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
    expect(applyMessages).toHaveBeenCalledWith('s1', []);
  });
});

