import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionsHttp URL encoding', () => {
  const envKeys = ['HAPPIER_SERVER_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('encodes sessionId path segments for fetchSessionById', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { fetchSessionById } = await import('./sessionsHttp');

    const sessionId = 'sess/../?x=1';
    const encoded = encodeURIComponent(sessionId);

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} } as any);
    await expect(fetchSessionById({ token: 't', sessionId })).resolves.toBeNull();

    expect(getSpy).toHaveBeenCalledWith(
      `http://server.example.test/v2/sessions/${encoded}`,
      expect.any(Object),
    );
  });

  it('encodes sessionId path segments for commitSessionStoredMessage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { commitSessionStoredMessage } = await import('./sessionsHttp');

    const sessionId = 'sess/../?x=1';
    const encoded = encodeURIComponent(sessionId);

    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 500, data: {} } as any);

    await expect(
      commitSessionStoredMessage({
        token: 't',
        sessionId,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
        localId: 'local-1',
      }),
    ).rejects.toThrow(/Unexpected status/);

    expect(postSpy.mock.calls[0]?.[0]).toBe(`http://server.example.test/v2/sessions/${encoded}/messages`);
  });
});

