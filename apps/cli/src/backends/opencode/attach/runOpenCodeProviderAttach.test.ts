import { describe, expect, it, vi } from 'vitest';

import { runOpenCodeProviderAttach } from './runOpenCodeProviderAttach';

type SpawnExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void;
type SpawnErrorHandler = (error: Error) => void;

describe('runOpenCodeProviderAttach', () => {
  it('spawns provider-native OpenCode attach with server URL, directory, and vendor session id', async () => {
    const exitHandlers: SpawnExitHandler[] = [];
    const errorHandlers: SpawnErrorHandler[] = [];
    const spawnProcess = vi.fn(() => ({
      once: (event: 'exit' | 'error', handler: SpawnExitHandler | SpawnErrorHandler) => {
        if (event === 'exit') exitHandlers.push(handler as SpawnExitHandler);
        if (event === 'error') errorHandlers.push(handler as SpawnErrorHandler);
      },
    }));

    const attachPromise = runOpenCodeProviderAttach({
      sessionId: 'happier-session-1',
      metadata: {
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'https://opencode.example.test/',
        opencodeServerBaseUrlExplicit: true,
      },
      command: 'opencode',
      commandArgs: ['--from-managed-runtime'],
      spawnProcess: spawnProcess as unknown as NonNullable<Parameters<typeof runOpenCodeProviderAttach>[0]['spawnProcess']>,
      readManagedServerStateFn: async () => null,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));

    expect(spawnProcess).toHaveBeenCalledWith(
      'opencode',
      [
        '--from-managed-runtime',
        'attach',
        'https://opencode.example.test/',
        '--dir',
        '/tmp/opencode-workspace',
        '--session',
        'opencode-session-1',
      ],
      expect.objectContaining({
        shell: false,
        stdio: 'inherit',
      }),
    );
    expect(errorHandlers).toHaveLength(1);
    expect(exitHandlers).toHaveLength(1);

    exitHandlers[0]?.(0, null);

    await expect(attachPromise).resolves.toBe(0);
  });
});
