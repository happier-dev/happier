import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

function createLegacyCredentials() {
  return {
    token: 'token-1',
    encryption: {
      type: 'legacy' as const,
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('sessionControl.sessionsHttp authentication status handling', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/api/session/resolveSessionCreateEncryptionMode');
  });

  it('throws a stable auth status error for fetchSessionById', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchSessionById } = await import('./sessionsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 401, data: {} } as never);

    await expect(fetchSessionById({ token: 'token-1', sessionId: 'sess-1' })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('throws a stable auth status error for fetchSessionsPage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchSessionsPage } = await import('./sessionsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 403, data: {} } as never);

    await expect(fetchSessionsPage({ token: 'token-1', limit: 10 })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 403 },
      code: 'not_authenticated',
    });
  });

  it('throws a stable auth status error for commitSessionStoredMessage without losing session-not-found semantics', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitSessionStoredMessage } = await import('./sessionsHttp');

    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as never);

    await expect(
      commitSessionStoredMessage({
        token: 'token-1',
        sessionId: 'sess-1',
        content: { t: 'plain', v: { type: 'user', text: 'hi' } },
        localId: 'local-1',
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });

    vi.restoreAllMocks();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 404, data: {} } as never);

    await expect(
      commitSessionStoredMessage({
        token: 'token-1',
        sessionId: 'sess-1',
        content: { t: 'plain', v: { type: 'user', text: 'hi' } },
        localId: 'local-2',
      }),
    ).rejects.toMatchObject({
      message: 'Session not found',
      code: 'session_not_found',
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('throws a stable auth status error for getOrCreateSessionByTag', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.doMock('@/api/session/resolveSessionCreateEncryptionMode', () => ({
      resolveSessionCreateEncryptionMode: vi.fn(async () => ({
        desiredSessionEncryptionMode: 'plain',
        serverSupportsFeatureSnapshot: true,
      })),
    }));
    vi.resetModules();
    const { getOrCreateSessionByTag } = await import('./sessionsHttp');

    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as never);

    await expect(
      getOrCreateSessionByTag({
        credentials: createLegacyCredentials(),
        tag: 'tag-1',
        metadata: { title: 'hello' },
        agentState: null,
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('keeps archive domain errors distinct while normalizing auth failures', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { archiveSession } = await import('./sessionsHttp');

    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as never);

    const authError = await archiveSession({ token: 'token-1', sessionId: 'sess-1' }).catch((error) => error);
    expect(authError).toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });

    vi.restoreAllMocks();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 409, data: {} } as never);

    await expect(archiveSession({ token: 'token-1', sessionId: 'sess-1' })).rejects.toMatchObject({
      message: 'Cannot archive an active session',
      code: 'session_active',
    });
  });
});
