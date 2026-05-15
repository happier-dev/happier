import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchEncryptedTranscriptMessagesPage, loggerDebug } = vi.hoisted(() => ({
  fetchEncryptedTranscriptMessagesPage: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessagesPage,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: loggerDebug,
  },
}));

describe('readRawSessionHistoryRows', () => {
  beforeEach(() => {
    fetchEncryptedTranscriptMessagesPage.mockReset();
    loggerDebug.mockReset();
  });

  it('does not prefilter stored roles when reading event history fallbacks', async () => {
    const { readRawSessionHistoryRows } = await import('./getSessionHistory');

    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 7,
          createdAt: 70,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                data: {
                  type: 'tool-call',
                  name: 'SubAgentRun',
                  input: { runId: 'run-1' },
                },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    await readRawSessionHistoryRows({
      token: 'token',
      sessionId: 'session-1',
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' },
      limit: 1,
    });

    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.not.objectContaining({
      roles: expect.anything(),
    }));
  });
});
