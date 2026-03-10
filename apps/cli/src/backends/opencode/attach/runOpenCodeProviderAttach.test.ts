import { describe, expect, it, vi } from 'vitest';

import { runOpenCodeProviderAttach } from './runOpenCodeProviderAttach';

describe('runOpenCodeProviderAttach', () => {
  it('reuses existing OpenCode session metadata and explicit server affinity to launch provider attach', async () => {
    const spawnProcess = vi.fn(() => ({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_1',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      },
      command: 'opencode',
      spawnProcess: spawnProcess as any,
      readManagedServerStateFn: async () => null,
    })).resolves.toBe(0);

    expect(spawnProcess).toHaveBeenCalledWith(
      'opencode',
      ['attach', 'http://127.0.0.1:4096/', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-1'],
      expect.objectContaining({
        stdio: 'inherit',
        shell: false,
      }),
    );
  });

  it('falls back to the shared managed OpenCode server URL when the session has no explicit server url', async () => {
    const spawnProcess = vi.fn(() => ({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_2',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-2',
        opencodeBackendMode: 'server',
      },
      command: 'opencode',
      spawnProcess: spawnProcess as any,
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:7777' } as any),
    })).resolves.toBe(0);

    expect(spawnProcess).toHaveBeenCalledWith(
      'opencode',
      ['attach', 'http://127.0.0.1:7777', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-2'],
      expect.any(Object),
    );
  });

  it('uses the resolved OpenCode CLI command when no explicit command override is passed', async () => {
    const spawnProcess = vi.fn(() => ({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_3',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-3',
        opencodeBackendMode: 'server',
      },
      env: {
        ...process.env,
        HAPPIER_OPENCODE_PATH: '/tmp/custom-opencode',
      },
      spawnProcess: spawnProcess as any,
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:8888' } as any),
      resolveCommandFn: () => '/tmp/custom-opencode',
    })).resolves.toBe(0);

    expect(spawnProcess).toHaveBeenCalledWith(
      '/tmp/custom-opencode',
      ['attach', 'http://127.0.0.1:8888', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-3'],
      expect.any(Object),
    );
  });
});
