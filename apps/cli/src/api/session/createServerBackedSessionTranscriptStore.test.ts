import { describe, expect, it, vi } from 'vitest';

const { fetchEncryptedTranscriptMessagesPageMock } = vi.hoisted(() => ({
  fetchEncryptedTranscriptMessagesPageMock: vi.fn(),
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessagesPage: fetchEncryptedTranscriptMessagesPageMock,
}));

import { createServerBackedSessionTranscriptStore } from './createServerBackedSessionTranscriptStore';

describe('createServerBackedSessionTranscriptStore', () => {
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
});
