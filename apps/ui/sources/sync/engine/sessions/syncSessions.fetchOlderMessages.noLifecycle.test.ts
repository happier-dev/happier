import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { fetchAndApplyOlderMessages } from './syncSessions';

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

function buildPlainApiMessage(id: string, seq: number): ApiMessage {
  return {
    id,
    seq,
    localId: null,
    sidechainId: null,
    content: {
      t: 'plain',
      v: { role: 'user', content: { type: 'text', text: `plain-${id}` } },
    },
    createdAt: 1_000 + seq,
    updatedAt: 2_000 + seq,
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
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      onTaskLifecycleEvent,
      log: { log: () => {} },
    });

    expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
    expect(applyMessages).toHaveBeenCalledWith('s1', []);
  });

  it('applies plaintext older pages without touching the encryption registry', async () => {
    const applyMessages = vi.fn();
    const getSessionEncryption = vi.fn(() => null);
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          messages: [buildPlainApiMessage('m_plain_older', 2)],
          hasMore: false,
          nextBeforeSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await fetchAndApplyOlderMessages({
      sessionId: 's_plain',
      sessionEncryptionMode: 'plain',
      beforeSeq: 10,
      limit: 150,
      getSessionEncryption,
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log: { log: () => {} },
    });

    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
      id: 'm_plain_older',
      role: 'user',
      seq: 2,
    });
  });

  it('marks scope=sidechain older-page messages when the API response omits sidechainId', async () => {
    const applyMessages = vi.fn();
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
        seq: 2,
        localId: null,
        createdAt: 1_002,
        content: {
          role: 'user',
          content: { type: 'text', text: 'hello' },
        },
      },
    ]);

    await fetchAndApplyOlderMessages({
      sessionId: 's1',
      beforeSeq: 10,
      limit: 150,
      scope: 'sidechain',
      sidechainId: 'tool_task_1',
      getSessionEncryption: () => ({ decryptMessages }),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log: { log: () => {} },
    });

    expect(applyMessages).toHaveBeenCalledWith('s1', [expect.objectContaining({
      id: 'm1',
      isSidechain: true,
      sidechainId: 'tool_task_1',
    })]);
  });
});
