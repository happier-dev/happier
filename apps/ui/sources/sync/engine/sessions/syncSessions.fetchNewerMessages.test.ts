import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
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

  it('applies plaintext newer pages without touching the encryption registry', async () => {
    const applyMessages = vi.fn();
    const getSessionEncryption = vi.fn(() => null);
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [buildPlainApiMessage('m_plain_newer', 2)],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await fetchAndApplyNewerMessages({
      sessionId: 's_plain',
      sessionEncryptionMode: 'plain',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption,
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log: { log: () => {} },
    });

    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
      id: 'm_plain_newer',
      role: 'user',
      seq: 2,
    });
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

    const normalized = applyMessages.mock.calls[0]?.[1]?.[0];
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
    });

    expect(onNormalizedMessages).toHaveBeenCalledTimes(1);
    expect(onNormalizedMessages.mock.calls[0]?.[0]?.[0]?.id).toBe('m1');
    expect(applyMessages).toHaveBeenCalledWith('s1', expect.any(Array));
  });

  it('does not write routine logs for empty newer pages', async () => {
    const applyMessages = vi.fn();
    const log = { log: vi.fn() };
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: () => ({
        decryptMessages: async () => [],
      }),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log,
    });

    expect(log.log).not.toHaveBeenCalled();
  });

  it('decrypts newer message pages in configured batches', async () => {
    const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [
          buildApiMessage('m1', 2),
          buildApiMessage('m2', 3),
          buildApiMessage('m3', 4),
        ],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const decryptMessages = vi.fn(async (apiMessages: ApiMessage[]) =>
      apiMessages.map((message) => ({
        id: message.id,
        seq: message.seq,
        localId: null,
        createdAt: message.createdAt,
        content: {
          role: 'user',
          content: { type: 'text', text: `hello-${message.id}` },
        },
      })),
    );
    const yieldToMessageDecryptBatch = vi.fn(async () => {});

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: () => ({ decryptMessages }),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      messageDecryptBatchSize: 2,
      messageDecryptYieldDelayMs: 7,
      yieldToMessageDecryptBatch,
      log: { log: () => {} },
    });

    expect(decryptMessages).toHaveBeenCalledTimes(2);
    expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(decryptMessages.mock.calls[1]?.[0].map((message) => message.id)).toEqual(['m3']);
    expect(yieldToMessageDecryptBatch).toHaveBeenCalledTimes(1);
    expect(yieldToMessageDecryptBatch).toHaveBeenCalledWith(7);
    expect(applyMessages.mock.calls[0]?.[1].map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('decrypts newer message pages in default-sized batches', async () => {
    const applyMessages = vi.fn();
    const messages = Array.from({ length: 33 }, (_, index) => buildApiMessage(`m${index + 1}`, index + 2));
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages,
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const decryptMessages = vi.fn(async (apiMessages: ApiMessage[]) =>
      apiMessages.map((message) => ({
        id: message.id,
        seq: message.seq,
        localId: null,
        createdAt: message.createdAt,
        content: {
          role: 'user',
          content: { type: 'text', text: `hello-${message.id}` },
        },
      })),
    );
    const yieldToMessageDecryptBatch = vi.fn(async () => {});

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: () => ({ decryptMessages }),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      yieldToMessageDecryptBatch,
      log: { log: () => {} },
    });

    expect(decryptMessages).toHaveBeenCalledTimes(5);
    expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(messages.slice(0, 8).map((message) => message.id));
    expect(decryptMessages.mock.calls[4]?.[0].map((message) => message.id)).toEqual(['m33']);
    expect(yieldToMessageDecryptBatch).toHaveBeenCalledWith(0);
  });

  it('marks scope=sidechain newer messages when the API response omits sidechainId', async () => {
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
