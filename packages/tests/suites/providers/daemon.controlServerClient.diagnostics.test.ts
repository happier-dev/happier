import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('daemonControlPostJson diagnostics', () => {
  it('wraps network errors with endpoint context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );

    await expect(
      daemonControlPostJson({
        port: 47001,
        path: '/stop',
        body: {},
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/port=47001.*path=\/stop/i);
  });

  it('keeps /spawn-session requests alive longer than the generic control timeout', async () => {
    vi.useFakeTimers();

    let aborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('This operation was aborted'));
          },
          { once: true },
        );
      })),
    );

    const pending = daemonControlPostJson({
      port: 47002,
      path: '/spawn-session',
      body: {},
    });
    const observed = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(observed).resolves.toBeInstanceOf(Error);
    await expect(pending).rejects.toThrow(/port=47002.*path=\/spawn-session/i);
    expect(aborted).toBe(true);
  });

  it('settles accepted asynchronous spawn responses before returning to test callers', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/spawn-session')) {
        return new Response(JSON.stringify({
          success: true,
          status: 'pending',
          sessionIdStatus: 'pending',
          spawnNonce: 'spawn-nonce-1',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/spawn-session/resolve')) {
        return new Response(JSON.stringify({
          success: true,
          status: 'success',
          sessionId: 'session-1',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await daemonControlPostJson<{
      success: true;
      status?: string;
      sessionId?: string;
      spawnNonce?: string;
    }>({
      port: 47003,
      path: '/spawn-session',
      body: { directory: '/tmp/project' },
    });

    expect(response).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        status: 'success',
        sessionId: 'session-1',
        spawnNonce: 'spawn-nonce-1',
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('settles accepted asynchronous spawns for UI E2E callers through the canonical control client', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/spawn-session')) {
        return new Response(JSON.stringify({
          success: true,
          status: 'pending',
          sessionIdStatus: 'pending',
          spawnNonce: 'ui-spawn-nonce-1',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/spawn-session/resolve')) {
        return new Response(JSON.stringify({
          success: true,
          status: 'success',
          sessionId: 'ui-session-1',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(spawnSessionFromDaemon({
      daemon: {
        state: {
          httpPort: 47004,
          controlToken: 'control-token',
        },
      } as Parameters<typeof spawnSessionFromDaemon>[0]['daemon'],
      directory: '/tmp/project',
    })).resolves.toBe('ui-session-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
