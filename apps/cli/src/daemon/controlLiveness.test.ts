import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { probeDaemonAuthenticatedControl } from './controlLiveness';

describe('probeDaemonAuthenticatedControl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([true, false])('scopes the daemon credential through real global Fetch (crossOrigin=%s)', async crossOrigin => {
    let initialCredential = false;
    let redirectedRequests = 0;
    let redirectedCredential = false;
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === '/ping') {
        initialCredential = Boolean(request.headers['x-happier-daemon-token']);
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing listener port');
        response.writeHead(302, { location: crossOrigin ? `http://localhost:${address.port}/redirected` : '/redirected' });
        response.end();
      } else {
        redirectedRequests += 1;
        redirectedCredential = Boolean(request.headers['x-happier-daemon-token']);
        response.setHeader('content-type', 'application/json');
        response.end('{"status":"ok"}');
      }
    });
    server.listen(0);
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener port');
      await expect(probeDaemonAuthenticatedControl({ pid: process.pid, httpPort: address.port,
        controlToken: 'synthetic-daemon-token', timeoutMs: 1_000 })).resolves.toBe('running');
      expect(initialCredential).toBe(true);
      expect(redirectedRequests).toBe(1);
      expect(redirectedCredential).toBe(!crossOrigin);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('keeps hidden ownership unverified when the control request fails without evidence of absence', async () => {
    const pidError = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw pidError; });
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeDaemonAuthenticatedControl({
      pid: 43210,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets authenticated control prove liveness when the daemon PID is hidden from this pid namespace', async () => {
    const pidError = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw pidError; });
    let observedToken: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      observedToken = String((init?.headers as Record<string, string> | undefined)?.['x-happier-daemon-token'] ?? '');
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }));

    await expect(probeDaemonAuthenticatedControl({
      pid: 987_654_321,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe('running');
    expect(observedToken).toBe('token-123');
  });

  it('does not let an unauthenticated answer resurrect a hidden PID', async () => {
    const pidError = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw pidError; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    await expect(probeDaemonAuthenticatedControl({
      pid: 987_654_321,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe('unauthorized');
  });

  it.each([
    ['EPERM', 'EPERM'],
    ['unknown error', undefined],
  ] as const)('keeps an inconclusive %s PID probe fail-closed', async (_label, code) => {
    const pidError = Object.assign(new Error('inconclusive PID liveness'), { code });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw pidError; });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeDaemonAuthenticatedControl({
      pid: 43210,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe('unreachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'unreachable'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'unreachable'],
    [429, 'unreachable'],
    [500, 'unreachable'],
    [503, 'unreachable'],
  ] as const)('classifies HTTP %s as %s', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));

    await expect(probeDaemonAuthenticatedControl({
      pid: process.pid,
      httpPort: 43213,
      controlToken: 'token-123',
      timeoutMs: 1_000,
    })).resolves.toBe(expected);
  });
  it.each([
    ['Node', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) })],
    // Bun 1.3.11 native closed-listener probe emits this direct code, without cause.
    ['Bun', Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })],
  ] as const)('distinguishes a %s refused endpoint from transient hidden-PID control failures and recovers', async (_runtime, connectionRefused) => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('PID hidden'), { code: 'ESRCH' }); });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockRejectedValueOnce(new DOMException('request timed out', 'TimeoutError'))
      .mockRejectedValueOnce(connectionRefused)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { pid: 43210, httpPort: 43213, controlToken: 'token-123', timeoutMs: 1_000 };
    await expect(probeDaemonAuthenticatedControl(input)).resolves.toBe('unreachable');
    await expect(probeDaemonAuthenticatedControl(input)).resolves.toBe('unreachable');
    await expect(probeDaemonAuthenticatedControl(input)).resolves.toBe('control_not_running');
    await expect(probeDaemonAuthenticatedControl(input)).resolves.toBe('running');
  });

});
