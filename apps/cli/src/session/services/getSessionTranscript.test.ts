import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchEncryptedTranscriptMessagesPage, resolveSessionTransportContext } = vi.hoisted(() => ({
  fetchEncryptedTranscriptMessagesPage: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessagesPage,
}));

vi.mock('./resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } };

describe('getSessionTranscript', () => {
  beforeEach(() => {
    fetchEncryptedTranscriptMessagesPage.mockReset();
    resolveSessionTransportContext.mockReset();
  });

  it('does not truncate semantic transcript message text by default', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const longText = 'x'.repeat(5001);
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' },
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: longText } } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({ credentials, idOrPrefix: 'sess-1' });

    expect(result).toMatchObject({
      ok: true,
      items: [
        { id: '1', role: 'user', kind: 'user_message', text: longText },
      ],
    });
    if (!result.ok) throw new Error('expected transcript result');
    expect(result.items[0]?.truncated).toBeUndefined();
  });

  it('truncates semantic transcript message text when a numeric truncation budget is supplied', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' },
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'abcdef' } } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({ credentials, idOrPrefix: 'sess-1', maxCharsPerMessage: 3 });

    expect(result).toMatchObject({
      ok: true,
      items: [
        { id: '1', role: 'user', kind: 'user_message', text: 'abc', truncated: true },
      ],
    });
  });

  it('does not stored-role prefilter when optional event-like transcript items are requested', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' },
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 3,
          createdAt: 30,
          messageRole: 'event',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                data: { type: 'tool-call', callId: 'call-1', name: 'Bash', input: { command: 'pwd' } },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: 'sess-1',
      includeTools: true,
    });

    expect(result).toMatchObject({
      ok: true,
      items: [
        {
          id: '3',
          role: 'tool',
          kind: 'tool_call',
          toolName: 'Bash',
        },
      ],
    });
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.not.objectContaining({
      roles: expect.anything(),
    }));
  });
});
