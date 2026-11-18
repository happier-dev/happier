import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { runProcess } = vi.hoisted(() => ({
  runProcess: vi.fn<(command: string, args: readonly string[], options: SpawnSyncOptions) => SpawnSyncReturns<string>>(),
}));

// Child processes are the boundary; the real DB coordinator owns step lifetime.
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawnSync: runProcess,
}));

import { main } from '../../../scripts/run-extended-db-docker.mjs';

describe('extended DB admitted step lifetime', () => {
  afterEach(() => { vi.unstubAllEnvs(); runProcess.mockReset(); });

  it.each([
    { setting: undefined, timeout: 3_600_000 },
    { setting: '0', timeout: 0 },
  ])('carries explicit step lifetime $setting to the process while retaining Docker bounds', async ({ setting, timeout }) => {
    vi.stubEnv('HAPPIER_E2E_EXTENDED_DB_STEP_TIMEOUT_MS', setting);
    vi.stubEnv('HAPPIER_E2E_EXTENDED_DB_DOCKER_TIMEOUT_MS', undefined);
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    runProcess.mockImplementation((command, args) => {
      const stdout = command !== 'docker' ? '' : args[0] === 'run' ? 'a'.repeat(64)
        : args[0] === 'inspect' ? 'healthy' : args[0] === 'port' ? '127.0.0.1:5432' : '';
      return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
    });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const originalListeners = signals.map(signal => new Set(process.listeners(signal)));
    try {
      expect(await main(['node', 'run-extended-db-docker.mjs', '--db', 'postgres', '--mode', 'e2e',
        '--e2e-file', 'suites/core-e2e/triage.platform.artifactRefresh.slow.e2e.test.ts'])).toBe(0);
      const step = runProcess.mock.calls.find(([command]) => command !== 'docker');
      expect(step).toBeDefined();
      expect(step?.[2].timeout).toBe(timeout);
      expect(runProcess.mock.calls.filter(([command]) => command === 'docker')
        .every(([, , options]) => typeof options.timeout === 'number' && options.timeout > 0)).toBe(true);
    } finally {
      signals.forEach((signal, index) => {
        for (const listener of process.listeners(signal)) {
          if (!originalListeners[index]!.has(listener)) process.removeListener(signal, listener);
        }
      });
    }
  });
});
