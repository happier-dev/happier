import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

describe('enqueueAutomationPrompt', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('posts plaintext pending content without requiring a session encryption key for plaintext sessions', async () => {
    const axiosModule = await import('axios');
    const axiosPost = vi.mocked(axiosModule.default.post);
    axiosPost.mockResolvedValue({ data: { ok: true } } as never);

    const { enqueueAutomationPrompt } = await import('./automationPendingQueueClient');

    await enqueueAutomationPrompt({
      token: 'token',
      sessionId: 'session-plain',
      prompt: 'Hello from automation',
      sessionEncryptionMode: 'plain',
      localId: '  opaque-automation-id  ',
    });

    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost.mock.calls[0]?.[1]).toEqual({
      localId: '  opaque-automation-id  ',
      messageRole: 'user',
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
      requestedAction: { v: 1, kind: 'enqueue' },
    });
    expect(String(axiosPost.mock.calls[0]?.[0] ?? '')).toContain('/v2/sessions/session-plain/pending');
  });

  it('rethrows terminal auth failures from enqueue', async () => {
    const axiosModule = await import('axios');
    const axiosPost = vi.mocked(axiosModule.default.post);
    axiosPost.mockRejectedValueOnce(new HttpStatusError(403, 'Authentication failed'));

    const { enqueueAutomationPrompt } = await import('./automationPendingQueueClient');

    await expect(
      enqueueAutomationPrompt({
        token: 'token',
        sessionId: 'session-plain',
        prompt: 'Hello from automation',
        sessionEncryptionMode: 'plain',
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 403 },
    });
  });
});
