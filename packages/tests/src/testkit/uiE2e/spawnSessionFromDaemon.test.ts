import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StartedDaemon } from '../daemon/daemon';
import { spawnSessionFromDaemon } from './spawnSessionFromDaemon';

describe('spawnSessionFromDaemon', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards additional spawn-session request fields to the daemon', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, sessionId: 'session-123' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const daemon = {
      state: {
        httpPort: 4231,
        controlToken: 'daemon-token',
      },
    } as StartedDaemon;

    const params: Parameters<typeof spawnSessionFromDaemon>[0] & Readonly<{
      request: Readonly<{
        sessionId: string;
        terminal: Readonly<{ mode: 'plain' }>;
        environmentVariables: Readonly<{ FOO: string }>;
      }>;
    }> = {
      daemon,
      directory: '/tmp/workspace',
      agent: 'codex',
      request: {
        sessionId: 'explicit-session',
        terminal: { mode: 'plain' },
        environmentVariables: { FOO: 'bar' },
      },
    };

    await expect(spawnSessionFromDaemon(params)).resolves.toBe('session-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:4231/spawn-session');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-happier-daemon-token': 'daemon-token',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      sessionId: 'explicit-session',
      terminal: { mode: 'plain' },
      environmentVariables: { FOO: 'bar' },
      directory: '/tmp/workspace',
      agent: 'codex',
    });
  });
});
