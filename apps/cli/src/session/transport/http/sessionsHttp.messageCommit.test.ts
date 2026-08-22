import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionsHttp message commits', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('posts plaintext stored content for commitSessionStoredMessage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitSessionStoredMessage } = await import('./sessionsHttp');

    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-1', seq: 7, localId: 'local-1', createdAt: 1234 },
      },
    } as any);

    await expect(
      commitSessionStoredMessage({
        token: 'token-1',
        sessionId: 'sess-1',
        content: { t: 'plain', v: { type: 'user', text: 'hello' } },
        localId: 'local-1',
      }),
    ).resolves.toMatchObject({
      didWrite: true,
      messageId: 'msg-1',
      localId: 'local-1',
      seq: 7,
      createdAt: 1234,
    });

    expect(postSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess-1/messages',
      {
        content: { t: 'plain', v: { type: 'user', text: 'hello' } },
        localId: 'local-1',
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'Idempotency-Key': 'local-1',
        }),
      }),
    );
  });

  it('wraps ciphertext commits as encrypted stored content', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitSessionEncryptedMessage } = await import('./sessionsHttp');

    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-2', seq: 8, localId: 'local-2', createdAt: 5678 },
      },
    } as any);

    await expect(
      commitSessionEncryptedMessage({
        token: 'token-2',
        sessionId: 'sess-2',
        ciphertext: 'ciphertext-abc',
        localId: 'local-2',
      }),
    ).resolves.toMatchObject({ didWrite: true, messageId: 'msg-2', seq: 8, createdAt: 5678 });

    expect(postSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess-2/messages',
      {
        content: { t: 'encrypted', c: 'ciphertext-abc' },
        localId: 'local-2',
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-2',
          'Idempotency-Key': 'local-2',
        }),
      }),
    );
  });

  it('derives attention impact from agent-event local IDs at the message sender', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitSessionStoredMessage } = await import('./sessionsHttp');

    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-event', seq: 9, localId: 'agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted', createdAt: 9012 },
      },
    } as any);

    await expect(
      commitSessionStoredMessage({
        token: 'token-event',
        sessionId: 'sess-event',
        content: { t: 'plain', v: { type: 'event', data: { type: 'agent-quota-wait' } } },
        localId: 'agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted',
        messageRole: 'event',
      }),
    ).resolves.toMatchObject({ didWrite: true, messageId: 'msg-event', seq: 9, createdAt: 9012 });

    expect(postSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess-event/messages',
      expect.objectContaining({
        localId: 'agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted',
        messageRole: 'event',
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
      }),
      expect.any(Object),
    );
  });
});
