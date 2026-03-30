import { describe, expect, it, vi } from 'vitest';

import { runOpenCodeProviderAttach } from './runOpenCodeProviderAttach';
import type { ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

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

  it('prefers agentRuntimeDescriptorV1 over legacy top-level OpenCode session metadata', async () => {
    const spawnProcess = vi.fn(() => ({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_descriptor_1',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'legacy-session-1',
        opencodeBackendMode: 'acp',
        opencodeServerBaseUrl: 'http://127.0.0.1:1111/',
        opencodeServerBaseUrlExplicit: true,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'descriptor-session-1',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
          },
        },
      },
      command: 'opencode',
      spawnProcess: spawnProcess as any,
      readManagedServerStateFn: async () => null,
    })).resolves.toBe(0);

    expect(spawnProcess).toHaveBeenCalledWith(
      'opencode',
      ['attach', 'http://127.0.0.1:4096/', '--dir', '/tmp/opencode-workspace', '--session', 'descriptor-session-1'],
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
      resolveCommandFn: (): ProviderCliLaunchSpec => ({
        source: 'override',
        resolvedPath: '/tmp/custom-opencode',
        command: '/tmp/custom-opencode',
        args: [],
      }),
    })).resolves.toBe(0);

    expect(spawnProcess).toHaveBeenCalledWith(
      '/tmp/custom-opencode',
      ['attach', 'http://127.0.0.1:8888', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-3'],
      expect.any(Object),
    );
  });

  it('does not resolve the CLI command when an explicit command override is provided', async () => {
    const spawnProcess = vi.fn(() => ({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));
    const resolveCommandFn: (env?: NodeJS.ProcessEnv) => ProviderCliLaunchSpec = vi.fn((): ProviderCliLaunchSpec => ({
      source: 'override',
      resolvedPath: '/tmp/unused-opencode',
      command: '/tmp/unused-opencode',
      args: [],
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_5',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-5',
        opencodeBackendMode: 'server',
      },
      command: '/tmp/custom-opencode',
      commandArgs: ['--stdio-wrapper'],
      spawnProcess: spawnProcess as any,
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:7777' } as any),
      resolveCommandFn,
    })).resolves.toBe(0);

    expect(resolveCommandFn).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith(
      '/tmp/custom-opencode',
      ['--stdio-wrapper', 'attach', 'http://127.0.0.1:7777', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-5'],
      expect.any(Object),
    );
  });

  it('prepends resolved launch args when the provider CLI needs a runtime wrapper', async () => {
    const spawnProcess = vi.fn(() => ({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_4',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-4',
        opencodeBackendMode: 'server',
      },
      spawnProcess: spawnProcess as any,
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:9999' } as any),
      resolveCommandFn: (): ProviderCliLaunchSpec => ({
        source: 'system',
        resolvedPath: '/tmp/custom-opencode',
        command: '/tmp/custom-node',
        args: ['/tmp/custom-opencode'],
      }),
    })).resolves.toBe(0);

    expect(spawnProcess).toHaveBeenCalledWith(
      '/tmp/custom-node',
      ['/tmp/custom-opencode', 'attach', 'http://127.0.0.1:9999', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-4'],
      expect.any(Object),
    );
  });
});
