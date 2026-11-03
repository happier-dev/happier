import { createServer } from 'node:http';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionListResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionsHttp timeouts', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses configuration.sessionControlHttpTimeoutMs for fetchSessionById and fetchSessionsPage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = '54321';

    vi.resetModules();

    const axiosGetMock = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 404, data: {} })
      .mockResolvedValueOnce({ status: 200, data: createSessionListResponseFixture([]) });

    const { fetchSessionById, fetchSessionsPage } = await import('./sessionsHttp');

    await expect(fetchSessionById({ reason: 'session-query', token: 't', sessionId: 's1' })).resolves.toBeNull();
    await expect(fetchSessionsPage({ token: 't', limit: 1 })).resolves.toMatchObject({ sessions: [] });

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(axiosGetMock.mock.calls[0]?.[1]?.timeout).toBe(54_321);
    expect(axiosGetMock.mock.calls[1]?.[1]?.timeout).toBe(54_321);
    expect(axiosGetMock.mock.calls[1]?.[0]).toBe('http://server.example.test/v2/sessions?limit=1');
  });

  async function withArchiveServer<T>(delayMs: number, run: (origin: string, paths: string[]) => Promise<T>) {
    const paths: string[] = [];
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      request.resume();
      const timer = setTimeout(() => {
        pending.delete(timer);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, archivedAt: request.url?.endsWith('/unarchive') ? null : 123 }));
      }, delayMs);
      pending.add(timer);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
    try {
      return await run(`http://127.0.0.1:${address.port}`, paths);
    } finally {
      for (const timer of pending) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }

  it('lets archive and unarchive finish beyond the unrelated session-control HTTP cutoff', async () => {
    process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = '1000';
    vi.resetModules();
    const { archiveSession, unarchiveSession } = await import('./sessionsHttp');
    const { runWithServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
    await withArchiveServer(1_500, async (origin, paths) => {
      const results = await runWithServerHttpBaseUrl(origin, () => Promise.allSettled([
        archiveSession({ token: 'fixture-token', sessionId: 's1' }),
        unarchiveSession({ token: 'fixture-token', sessionId: 's1' }),
      ]));
      expect(results.map(result => result.status === 'fulfilled' ? result : {
        status: result.status,
        error: axios.isAxiosError(result.reason) ? result.reason.message : String(result.reason),
      })).toEqual([
        { status: 'fulfilled', value: { archivedAt: 123 } },
        { status: 'fulfilled', value: { archivedAt: null } },
      ]);
      expect(paths.sort()).toEqual(['/v2/sessions/s1/archive', '/v2/sessions/s1/unarchive']);
    });
  });

  it('retires both HTTP mutations when the containing caller cancels and reports their uncertain outcome', async () => {
    process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = '30000';
    vi.resetModules();
    const { archiveSession, unarchiveSession } = await import('./sessionsHttp');
    const { runWithServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
    const controller = new AbortController();
    await withArchiveServer(1_500, async (origin, paths) => {
      const settled = runWithServerHttpBaseUrl(origin, () => Promise.allSettled([
        archiveSession({ token: 'fixture-token', sessionId: 's1', signal: controller.signal }),
        unarchiveSession({ token: 'fixture-token', sessionId: 's1', signal: controller.signal }),
      ]));
      await vi.waitFor(() => expect(paths).toHaveLength(2));
      controller.abort();
      const results = await settled;
      expect(results).toMatchObject([
        { status: 'rejected', reason: { code: 'outcome_unknown', cause: { code: 'ERR_CANCELED' } } },
        { status: 'rejected', reason: { code: 'outcome_unknown', cause: { code: 'ERR_CANCELED' } } },
      ]);
    });
  });
});
