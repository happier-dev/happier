import { afterEach, describe, expect, it, vi } from 'vitest';

import axios, { type GenericAbortSignal } from 'axios';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionsHttp lookup by tags', () => {
  const envKeys = ['HAPPIER_SERVER_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
  });

  it('posts the bounded tags with the remaining absolute deadline and signal', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const signal = new AbortController().signal;
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: {
        sessions: [
          createSessionRecordFixture({
            id: 'active-session',
            metadataVersion: 0,
            agentStateVersion: 0,
          }),
          createSessionRecordFixture({
            id: 'archived-session',
            archivedAt: 900,
            metadataVersion: 0,
            agentStateVersion: 0,
          }),
        ],
      },
    } as any);
    const { lookupSessionsByTags } = await import('./sessionsHttp');

    await expect(lookupSessionsByTags({
      token: 'token-1',
      tags: ['direct:v1:one', 'direct:v1:two'],
      signal,
      deadlineAtMs: 1_375,
    })).resolves.toMatchObject({
      state: 'available',
      tags: ['direct:v1:one', 'direct:v1:two'],
      sessions: [
        { id: 'active-session' },
        { id: 'archived-session' },
      ],
    });
    expect(post).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/lookup-by-tags',
      { tags: ['direct:v1:one', 'direct:v1:two'] },
      expect.objectContaining({
        signal,
        timeout: 375,
      }),
    );
  });

  it('returns typed unavailable for an old server 404', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 404,
      data: {
        statusCode: 404,
        error: 'Not Found',
        message: 'Route POST:/v2/sessions/lookup-by-tags not found',
      },
    } as any);
    const { lookupSessionsByTags } = await import('./sessionsHttp');

    await expect(lookupSessionsByTags({
      token: 'token-1',
      tags: ['direct:v1:one'],
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 500,
    })).resolves.toEqual({ state: 'unavailable' });
  });

  it('does not treat an unrelated 404 as proof that the route is unavailable', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 404,
      data: {
        statusCode: 404,
        error: 'Not Found',
        message: 'Session lookup rejected',
        path: '/v2/sessions/lookup-by-tags',
      },
    } as any);
    const { lookupSessionsByTags } = await import('./sessionsHttp');

    await expect(lookupSessionsByTags({
      token: 'token-1',
      tags: ['direct:v1:one'],
    })).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('passes the composed signal into Axios so cancellation aborts the request', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    let observedSignal: GenericAbortSignal | undefined;
    vi.spyOn(axios, 'post').mockImplementation(
      async (_url, _body, config) => await new Promise((_resolve, reject) => {
        observedSignal = config?.signal;
        if (!observedSignal?.addEventListener) {
          throw new Error('Expected Axios to receive a cancellable signal');
        }
        observedSignal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
    );
    const controller = new AbortController();
    const { lookupSessionsByTags } = await import('./sessionsHttp');
    const pending = lookupSessionsByTags({
      token: 'token-1',
      tags: ['direct:v1:one'],
      signal: controller.signal,
      deadlineAtMs: Date.now() + 500,
    });

    controller.abort();

    expect(observedSignal).toBe(controller.signal);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
