import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

describe('enqueueAndMaterializeAutomationPrompt', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('posts plaintext pending content without requiring a session encryption key for plaintext sessions', async () => {
    const axiosModule = await import('axios');
    const axiosPost = vi.mocked(axiosModule.default.post);
    axiosPost.mockResolvedValue({ data: { ok: true } } as never);

    const { enqueueAndMaterializeAutomationPrompt } = await import('./automationPendingQueueClient');

    await enqueueAndMaterializeAutomationPrompt({
      token: 'token',
      sessionId: 'session-plain',
      prompt: 'Hello from automation',
      sessionEncryptionMode: 'plain',
    });

    expect(axiosPost).toHaveBeenCalledTimes(2);
    expect(axiosPost.mock.calls[0]?.[1]).toEqual({
      localId: expect.any(String),
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: {
            type: 'text',
            text: 'Hello from automation',
          },
          meta: {
            sentFrom: 'cli',
            source: 'automation',
          },
        },
      },
    });
    expect(String(axiosPost.mock.calls[1]?.[0] ?? '')).toContain('/v2/sessions/session-plain/pending/materialize-next');
  });
});
