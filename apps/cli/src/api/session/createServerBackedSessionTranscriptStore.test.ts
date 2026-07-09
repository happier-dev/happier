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

  it('treats the tail cursor as current end instead of replaying historical messages', async () => {
    fetchEncryptedTranscriptMessagesPageMock.mockResolvedValue({
      messages: [
        {
          seq: 41,
          createdAt: 1,
          content: { t: 'plain', v: { type: 'agent_message', text: 'historical' } },
        },
      ],
      hasMore: true,
      nextBeforeSeq: 41,
      nextAfterSeq: 42,
    });
    const store = createServerBackedSessionTranscriptStore({
      token: 'token',
      sessionId: 'session-1',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });

    await expect(store.readAfter({ cursor: 'tail', maxItems: 100, maxBytes: 64 * 1024 })).resolves.toEqual({
      items: [],
      nextCursor: '42',
      truncated: false,
    });
    expect(fetchEncryptedTranscriptMessagesPageMock).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-1',
      limit: 1,
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
              provider: 'codex',
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
              provider: 'codex',
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
