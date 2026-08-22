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

const credentials = { token: 'token', encryption: null } as const;

describe('getSessionEvents', () => {
  beforeEach(() => {
    fetchEncryptedTranscriptMessagesPage.mockReset();
    resolveSessionTransportContext.mockReset();
  });

  it('recovers historical event rows without default stored-role prefiltering', async () => {
    const { getSessionEvents } = await import('./getSessionEvents');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 4,
          createdAt: 40,
          messageRole: 'agent',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                provider: 'codex',
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

    const result = await getSessionEvents({ credentials, idOrPrefix: 'sess-1' });

    expect(result).toMatchObject({
      ok: true,
      items: [
        {
          id: '4',
          storedMessageRole: 'agent',
          semanticRole: 'tool',
          kind: 'tool_call',
          toolName: 'Bash',
        },
      ],
    });
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.not.objectContaining({
      roles: expect.anything(),
    }));
  });

  it('passes explicit stored-role filters to the server', async () => {
    const { getSessionEvents } = await import('./getSessionEvents');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    await getSessionEvents({ credentials, idOrPrefix: 'sess-1', roles: ['event'] });

    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.objectContaining({
      roles: ['event'],
    }));
  });
});
