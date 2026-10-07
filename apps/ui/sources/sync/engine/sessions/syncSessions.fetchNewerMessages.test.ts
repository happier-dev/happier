import { type SessionMessageV1 } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import type { NormalizedMessage, RawRecord } from "@happier-dev/session-core/raw";
import { fetchAndApplyNewerMessages } from './syncSessions';

let encryption: Encryption;
let sessionEncryption: NonNullable<ReturnType<Encryption['getSessionEncryption']>>;

async function buildApiMessage(id: string, seq: number, raw: RawRecord = {
    role: 'user', content: { type: 'text', text: `hello-${id}` },
}): Promise<SessionMessageV1> {
    return {
        id,
        seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'encrypted',
            c: await sessionEncryption.encryptRawRecord(raw),
        },
        createdAt: 1_000 + seq,
        updatedAt: 2_000 + seq,
    };
}

function buildPlainApiMessage(id: string, seq: number): SessionMessageV1 {
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
  beforeEach(async () => {
    storage.setState(storage.getInitialState(), true);
    storage.getState().applySessions([
      createSessionFixture({ id: 's1', encryptionMode: 'e2ee', encryptedContentAvailability: 'ready' }),
      createSessionFixture({ id: 's_plain', encryptionMode: 'plain' }),
    ]);
    encryption = await Encryption.create(new Uint8Array(32).fill(3));
    await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(4)]]));
    const cipher = encryption.getSessionEncryption('s1');
    if (!cipher) throw new Error('Encrypted Session fixture was not initialized');
    sessionEncryption = cipher;
  });
  afterEach(() => vi.restoreAllMocks());

  function observeAppliedMessages() {
    return vi.fn((id: string, messages: NormalizedMessage[]) => storage.getState().applyMessages(id, messages));
  }

  it('emits lifecycle events from ACP messages even when they do not normalize into visible transcript rows', async () => {
        const applyMessages = observeAppliedMessages();
        const onTaskLifecycleEvent = vi.fn();
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [await buildApiMessage('m1', 2, {
                    role: 'agent', content: { type: 'acp', agentId: 'kimi',
                      data: { type: 'turn_aborted', id: 'task-1' } },
                })],
                nextAfterSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        await fetchAndApplyNewerMessages({
            sessionId: 's1',
            afterSeq: 1,
            limit: 150,
            getSessionEncryption: (id) => encryption.getSessionEncryption(id),
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
    const applyMessages = observeAppliedMessages();
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
    const applyMessages = observeAppliedMessages();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [await buildApiMessage('m1', 2)],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: (id) => encryption.getSessionEncryption(id),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log: { log: () => {} },
    });

    const normalized = applyMessages.mock.calls[0]?.[1]?.[0];
    expect(normalized?.seq).toBe(2);
  });

  it('marks only explicitly stale ids as authoritative updates during a targeted newer refetch', async () => {
    const applyMessages = observeAppliedMessages();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [buildPlainApiMessage('ordinary-row', 2), buildPlainApiMessage('stale-row', 3)],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const targetRefetch = {
      sessionId: 's1',
      sessionEncryptionMode: 'plain' as const,
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: () => null,
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log: { log: () => {} },
      authoritativeUpdateMessageIds: new Set(['stale-row']),
    };

    await fetchAndApplyNewerMessages(targetRefetch);

    const normalized = applyMessages.mock.calls[0]?.[1];
    expect(normalized?.[0]).toMatchObject({ id: 'ordinary-row' });
    expect(normalized?.[0]).not.toHaveProperty('isAuthoritativeUpdate');
    expect(normalized?.[1]).toMatchObject({ id: 'stale-row', isAuthoritativeUpdate: true });
  });

  it('calls onNormalizedMessages with the normalized messages before applying them', async () => {
    const applyMessages = observeAppliedMessages();
    const onNormalizedMessages = vi.fn();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [await buildApiMessage('m1', 2)],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: (id) => encryption.getSessionEncryption(id),
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
    const applyMessages = observeAppliedMessages();
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
      getSessionEncryption: (id) => encryption.getSessionEncryption(id),
      request,
      sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages,
      log,
    });

    expect(log.log).not.toHaveBeenCalled();
  });

  it('decrypts newer message pages in configured batches', async () => {
    const applyMessages = observeAppliedMessages();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [
          await buildApiMessage('m1', 2),
          await buildApiMessage('m2', 3),
          await buildApiMessage('m3', 4),
        ],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const decryptMessages = vi.spyOn(sessionEncryption, 'decryptMessages');
    const yieldToMessageDecryptBatch = vi.fn(async () => {});

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: (id) => encryption.getSessionEncryption(id),
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
    const applyMessages = observeAppliedMessages();
    const messages = await Promise.all(Array.from({ length: 33 }, (_, index) => buildApiMessage(`m${index + 1}`, index + 2)));
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages,
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const decryptMessages = vi.spyOn(sessionEncryption, 'decryptMessages');
    const yieldToMessageDecryptBatch = vi.fn(async () => {});

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      getSessionEncryption: (id) => encryption.getSessionEncryption(id),
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
    const applyMessages = observeAppliedMessages();
    const request = vi.fn(async () => new Response(
      JSON.stringify({
        messages: [await buildApiMessage('m1', 2)],
        nextAfterSeq: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await fetchAndApplyNewerMessages({
      sessionId: 's1',
      afterSeq: 1,
      limit: 150,
      scope: 'sidechain',
      sidechainId: 'tool_task_1',
      getSessionEncryption: (id) => encryption.getSessionEncryption(id),
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
