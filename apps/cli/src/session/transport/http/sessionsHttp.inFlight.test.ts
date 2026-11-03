import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionsHttp in-flight session detail coalescing', () => {
  const envKeys = ['HAPPIER_SERVER_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('shares concurrent fetchSessionById requests for the same token and session', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { fetchSessionById } = await import('./sessionsHttp');

    let resolveResponse: ((value: unknown) => void) | undefined;
    const responsePromise = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const getSpy = vi.spyOn(axios, 'get').mockReturnValue(responsePromise as any);

    const first = fetchSessionById({ reason: 'session-query', token: 'token-1', sessionId: 'sess-1' });
    const second = fetchSessionById({ reason: 'session-query', token: 'token-1', sessionId: 'sess-1' });

    expect(getSpy).toHaveBeenCalledTimes(1);

    resolveResponse?.({
      status: 200,
      data: { session: createSessionRecordFixture({ id: 'sess-1', metadataVersion: 0, agentStateVersion: 0 }) },
    });

    await expect(first).resolves.toMatchObject({ id: 'sess-1' });
    await expect(second).resolves.toMatchObject({ id: 'sess-1' });

    getSpy.mockResolvedValueOnce({
      status: 200,
      data: { session: createSessionRecordFixture({ id: 'sess-1', metadataVersion: 0, agentStateVersion: 0 }) },
    } as any);

    await expect(fetchSessionById({ reason: 'session-query', token: 'token-1', sessionId: 'sess-1' })).resolves.toMatchObject({ id: 'sess-1' });
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps requester binding separate from legacy reads while newly named queries share the legacy request', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { fetchSessionById } = await import('./sessionsHttp');

    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const responsePromise = responseGate.then(() => ({
      status: 200,
      data: { session: createSessionRecordFixture({ id: 'sess-1', metadataVersion: 0, agentStateVersion: 0 }) },
    }));
    const getSpy = vi.spyOn(axios, 'get').mockReturnValue(responsePromise);

    const requester = fetchSessionById({ reason: 'requester-binding', token: 'token-1', sessionId: 'sess-1' });
    const legacy = fetchSessionById({ reason: 'legacy-compat-proof', token: 'token-1', sessionId: 'sess-1' });
    const query = fetchSessionById({ reason: 'session-query', token: 'token-1', sessionId: 'sess-1' });

    try {
      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(getSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({ 'X-Happier-Request-Purpose': 'session-detail:requester-binding' }),
      }));
      expect(getSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({ 'X-Happier-Request-Purpose': 'session-detail:legacy-compat-proof' }),
      }));
    } finally {
      releaseResponse?.();
    }

    await expect(Promise.all([requester, legacy, query])).resolves.toEqual([
      expect.objectContaining({ id: 'sess-1' }),
      expect.objectContaining({ id: 'sess-1' }),
      expect.objectContaining({ id: 'sess-1' }),
    ]);
  });
});
