import { type SessionMessageV1 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage, RawRecord } from '@happier-dev/session-core/raw';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { fetchAndApplyOlderMessages } from './syncSessions';

function buildApiMessage(id: string, seq: number, raw: RawRecord): SessionMessageV1 {
  return {
    id,
    seq,
    localId: null,
    sidechainId: null,
    content: {
      t: 'plain',
      v: raw,
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

describe('fetchAndApplyOlderMessages', () => {
  beforeEach(() => {
    storage.setState(storage.getInitialState(), true);
    storage.getState().applySessions(['s1', 's_plain'].map(id => createSessionFixture({ id, encryptionMode: 'plain' })));
  });

  function observeAppliedMessages() {
    return vi.fn((id: string, messages: NormalizedMessage[]) => storage.getState().applyMessages(id, messages));
  }

  it('does not emit lifecycle events from older pages', async () => {
    const applyMessages = observeAppliedMessages();
    const onTaskLifecycleEvent = vi.fn();
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          messages: [buildApiMessage('m1', 2, {
            role: 'agent', content: { type: 'acp', agentId: 'kimi',
              data: { type: 'task_complete', id: 'task-1' } },
          })],
          hasMore: false,
          nextBeforeSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await fetchAndApplyOlderMessages({
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      beforeSeq: 10,
      limit: 150,
      getSessionEncryption: () => null,
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
    const applyMessages = observeAppliedMessages();
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
    const applyMessages = observeAppliedMessages();
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          messages: [buildApiMessage('m1', 2, {
            role: 'user', content: { type: 'text', text: 'hello' },
          })],
          hasMore: false,
          nextBeforeSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await fetchAndApplyOlderMessages({
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      beforeSeq: 10,
      limit: 150,
      scope: 'sidechain',
      sidechainId: 'tool_task_1',
      getSessionEncryption: () => null,
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
