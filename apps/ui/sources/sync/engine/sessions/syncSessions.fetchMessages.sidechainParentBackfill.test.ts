import { type SessionMessageV1 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage, RawRecord } from '@happier-dev/session-core/raw';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { fetchAndApplyMessages } from './syncSessions';

function buildApiMessage(id: string, seq: number, raw: RawRecord): SessionMessageV1 {
  return { id, seq, localId: null, sidechainId: null, content: { t: 'plain', v: raw },
    createdAt: 1_000 + seq, updatedAt: 2_000 + seq };
}

function agentMessage(text: string, sidechainId?: string): RawRecord {
  return { role: 'agent', content: { type: 'acp', agentId: 'claude',
    data: { type: 'message', message: text, ...(sidechainId ? { sidechainId } : {}) } } };
}

describe('fetchAndApplyMessages (sidechain parent backfill)', () => {
  beforeEach(() => {
    storage.setState(storage.getInitialState(), true);
    storage.getState().applySessions([createSessionFixture({ id: 's1', encryptionMode: 'plain' })]);
  });

  function observeAppliedMessages() {
    return vi.fn((id: string, messages: NormalizedMessage[]) => storage.getState().applyMessages(id, messages));
  }

  for (const includeRoot of [false, true]) {
    it(includeRoot
      ? 'does not backfill older pages when sidechain messages reference a missing owning tool-call'
      : 'does not backfill older pages for sidechain-only pages (sidechains are loaded explicitly)', async () => {
      const applyMessages = observeAppliedMessages();
      const markMessagesLoaded = vi.fn((id: string) => storage.getState().applyMessagesLoaded(id));
      const request = vi.fn(async (path: string) => new Response(JSON.stringify(path.includes('beforeSeq=') ? {
        messages: [buildApiMessage('parent', 99, { role: 'agent', content: { type: 'acp', agentId: 'claude',
          data: { type: 'tool-call', callId: 'tool_task_1', input: '{}', name: 'Task', id: 'uuid_parent' } } })],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } : {
        messages: [
          ...(includeRoot ? [buildApiMessage('root', 102, agentMessage('root'))] : []),
          buildApiMessage('side1', 101, agentMessage('child', 'tool_task_1')),
          buildApiMessage('side2', 100, agentMessage('child', 'tool_task_1')),
        ],
        hasMore: true, nextBeforeSeq: 100, nextAfterSeq: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      await fetchAndApplyMessages({
        sessionId: 's1', sessionEncryptionMode: 'plain', getSessionEncryption: () => null,
        request, sessionReceivedMessages: new Map<string, Map<string, number>>(),
        applyMessages, markMessagesLoaded, log: { log: () => {} },
      });

      // Main-transcript paging must not scan backwards for sidechain parents.
      expect(request).toHaveBeenCalledTimes(1);
      expect(applyMessages).toHaveBeenCalledTimes(1);
      expect(applyMessages.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'side1', isSidechain: true, sidechainId: 'tool_task_1' }),
        expect.objectContaining({ id: 'side2', isSidechain: true, sidechainId: 'tool_task_1' }),
      ]));
      expect(markMessagesLoaded).toHaveBeenCalledTimes(1);
    });
  }

  it('marks scope=sidechain messages as sidechain messages even when the response omits sidechainId', async () => {
    const applyMessages = observeAppliedMessages();
    const request = vi.fn(async () => new Response(JSON.stringify({
      messages: [buildApiMessage('side1', 101, { role: 'user', content: { type: 'text', text: 'hello' } })],
      hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await fetchAndApplyMessages({
      sessionId: 's1', sessionEncryptionMode: 'plain', scope: 'sidechain', sidechainId: 'tool_task_1',
      getSessionEncryption: () => null, request, sessionReceivedMessages: new Map<string, Map<string, number>>(),
      applyMessages, markMessagesLoaded: id => storage.getState().applyMessagesLoaded(id), log: { log: () => {} },
    });

    expect(applyMessages).toHaveBeenCalledWith('s1', [expect.objectContaining({
      id: 'side1', isSidechain: true, sidechainId: 'tool_task_1',
    })]);
  });
});
