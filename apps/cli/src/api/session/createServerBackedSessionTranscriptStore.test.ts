import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchEncryptedTranscriptMessagesPageMock } = vi.hoisted(() => ({
  fetchEncryptedTranscriptMessagesPageMock: vi.fn(),
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessagesPage: fetchEncryptedTranscriptMessagesPageMock,
}));

import { createServerBackedSessionTranscriptStore } from './createServerBackedSessionTranscriptStore';

describe('createServerBackedSessionTranscriptStore', () => {
  beforeEach(() => {
    fetchEncryptedTranscriptMessagesPageMock.mockReset();
  });

  it('uses the newest returned sequence as the tail cursor when the server omits nextAfterSeq', async () => {
    fetchEncryptedTranscriptMessagesPageMock.mockResolvedValue({
      messages: [
        {
          seq: 41,
          createdAt: 1,
          content: { t: 'plain', v: { type: 'agent_message', text: 'historical' } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });
    const store = createServerBackedSessionTranscriptStore({
      token: 'token',
      sessionId: 'session-1',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });

    await expect(store.readAfter({ cursor: 'tail', maxItems: 100, maxBytes: 64 * 1024 })).resolves.toEqual({
      items: [],
      nextCursor: '41',
      truncated: false,
    });
    expect(fetchEncryptedTranscriptMessagesPageMock).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-1',
      limit: 1,
    });
  });

  it('starts an empty tail at zero so a later row can be read after it', async () => {
    fetchEncryptedTranscriptMessagesPageMock
      .mockResolvedValueOnce({
        messages: [],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            seq: 1,
            createdAt: 1,
            content: { t: 'plain', v: { type: 'agent_message', text: 'newly appended' } },
          },
        ],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      });
    const store = createServerBackedSessionTranscriptStore({
      token: 'token',
      sessionId: 'session-1',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });

    const tail = await store.readAfter({ cursor: 'tail', maxItems: 100, maxBytes: 64 * 1024 });

    expect(tail).toEqual({
      items: [],
      nextCursor: '0',
      truncated: false,
    });
    await expect(store.readAfter({ cursor: tail.nextCursor, maxItems: 100, maxBytes: 64 * 1024 })).resolves.toMatchObject({
      items: [expect.objectContaining({ seq: 1 })],
      nextCursor: '1',
      truncated: false,
    });
    expect(fetchEncryptedTranscriptMessagesPageMock).toHaveBeenLastCalledWith({
      token: 'token',
      sessionId: 'session-1',
      limit: 100,
      afterSeq: 0,
    });
  });

  it('continues from the last emitted sequence when byte limiting a forward server page', async () => {
    const oversizedText = 'x'.repeat(64 * 1024);
    fetchEncryptedTranscriptMessagesPageMock.mockImplementation(async ({ afterSeq }: { afterSeq?: number }) => {
      if (afterSeq === 0) {
        return {
          messages: [
            {
              seq: 1,
              createdAt: 1,
              content: { t: 'plain', v: { type: 'agent_message', text: oversizedText } },
            },
            {
              seq: 2,
              createdAt: 2,
              content: { t: 'plain', v: { type: 'agent_message', text: oversizedText } },
            },
          ],
          hasMore: true,
          nextBeforeSeq: null,
          nextAfterSeq: 2,
        };
      }
      if (afterSeq === 1) {
        return {
          messages: [
            {
              seq: 2,
              createdAt: 2,
              content: { t: 'plain', v: { type: 'agent_message', text: oversizedText } },
            },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        };
      }
      return {
        messages: [],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      };
    });
    const store = createServerBackedSessionTranscriptStore({
      token: 'token',
      sessionId: 'session-1',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });

    const first = await store.readAfter({ cursor: '0', maxItems: 100, maxBytes: 64 * 1024 });

    expect(first).toMatchObject({
      items: [expect.objectContaining({ seq: 1 })],
      nextCursor: '1',
      truncated: true,
    });

    await expect(store.readAfter({ cursor: first.nextCursor, maxItems: 100, maxBytes: 64 * 1024 })).resolves.toMatchObject({
      items: [expect.objectContaining({ seq: 2 })],
      nextCursor: '2',
      truncated: false,
    });
    expect(fetchEncryptedTranscriptMessagesPageMock).toHaveBeenLastCalledWith({
      token: 'token',
      sessionId: 'session-1',
      limit: 100,
      afterSeq: 1,
    });
  });

  it('continues an older page from the last emitted sequence when byte limiting', async () => {
    const oversizedText = 'x'.repeat(64 * 1024);
    fetchEncryptedTranscriptMessagesPageMock.mockImplementation(async ({ beforeSeq }: { beforeSeq?: number }) => {
      if (beforeSeq === undefined) {
        return {
          messages: [
            {
              seq: 2,
              createdAt: 2,
              content: { t: 'plain', v: { type: 'agent_message', text: oversizedText } },
            },
            {
              seq: 1,
              createdAt: 1,
              content: { t: 'plain', v: { type: 'agent_message', text: oversizedText } },
            },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        };
      }
      if (beforeSeq === 2) {
        return {
          messages: [
            {
              seq: 1,
              createdAt: 1,
              content: { t: 'plain', v: { type: 'agent_message', text: oversizedText } },
            },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        };
      }
      return {
        messages: [],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      };
    });
    const store = createServerBackedSessionTranscriptStore({
      token: 'token',
      sessionId: 'session-1',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });

    const first = await store.pageOlder({ maxItems: 100, maxBytes: 64 * 1024 });

    expect(first).toMatchObject({
      items: [expect.objectContaining({ seq: 2 })],
      nextCursor: '2',
      hasMore: true,
      truncated: true,
    });

    await expect(store.pageOlder({ cursor: first.nextCursor, maxItems: 100, maxBytes: 64 * 1024 })).resolves.toMatchObject({
      items: [expect.objectContaining({ seq: 1 })],
      nextCursor: null,
      hasMore: false,
      truncated: false,
    });
    expect(fetchEncryptedTranscriptMessagesPageMock).toHaveBeenLastCalledWith({
      token: 'token',
      sessionId: 'session-1',
      limit: 100,
      beforeSeq: 2,
    });
  });

  it('suppresses empty canonical turn diff tool-call/result pairs for server-backed transcript actions', async () => {
    const turnDiffInput = {
      files: [],
      _happier: {
        sessionChangeScope: 'turn',
        turnId: 'turn-1',
        sessionId: 'session-1',
        provider: 'codex',
        source: 'scm_checkpoint',
        confidence: 'exact',
        turnStatus: 'completed',
        seqRange: {
          startSeqInclusive: 10,
          endSeqInclusive: 11,
        },
      },
    };
    const rows = [
      {
        seq: 10,
        createdAt: 100,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'codex',
              data: {
                type: 'tool-call',
                callId: 'diff-empty-1',
                name: 'Diff',
                input: JSON.stringify(turnDiffInput),
              },
            },
          },
        },
      },
      {
        seq: 11,
        createdAt: 101,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'codex',
              data: {
                type: 'tool-result',
                callId: 'diff-empty-1',
                output: JSON.stringify({ status: 'completed', files: [] }),
              },
            },
          },
        },
      },
      {
        seq: 12,
        createdAt: 102,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'message',
              message: 'visible',
            },
          },
        },
      },
    ];
    fetchEncryptedTranscriptMessagesPageMock
      .mockResolvedValueOnce({
        messages: rows,
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: 13,
      })
      .mockResolvedValueOnce({
        messages: rows,
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: 13,
      });
    const store = createServerBackedSessionTranscriptStore({
      token: 'token',
      sessionId: 'session-1',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });

    await expect(store.pageOlder({ maxItems: 100, maxBytes: 64 * 1024 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          seq: 12,
          text: 'visible',
        }),
      ],
    });
    await expect(store.readAfter({ cursor: '11', maxItems: 100, maxBytes: 64 * 1024 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          seq: 12,
          text: 'visible',
        }),
      ],
    });
  });
});
