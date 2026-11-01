import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
// The service plans and command discovery stay real; only execution crosses the OS boundary.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

import { applyServicePlan, inspectServiceRegistration, planServiceAction } from './manager';

describe('Windows background service consoles', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
    spawnSyncMock.mockReset();
  });

  it.each([
    { configuredTimeout: undefined, elapsedMs: 15_001, queryTimesOut: false },
    { configuredTimeout: '3400', elapsedMs: 1, queryTimesOut: false },
    { configuredTimeout: '3400', elapsedMs: 15_001, queryTimesOut: true },
  ])('hides scheduler mutation and honors only an explicit inspection deadline ($configuredTimeout, elapsed $elapsedMs)', async ({ configuredTimeout, elapsedMs, queryTimesOut }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-service-console-'));
    try {
      await Promise.all(['powershell.exe', 'schtasks.exe'].map((name) => writeFile(join(directory, name), '')));
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      vi.stubEnv('PATH', directory);
      vi.stubEnv('HAPPIER_WINDOWS_SCHTASKS_TIMEOUT_MS', configuredTimeout);
      const observedQueryTimeouts: Array<number | undefined> = [];
      spawnSyncMock.mockImplementation((command: string, args: readonly string[], options?: { timeout?: number }) => {
        if (command === 'powershell.exe' && args.some((arg) => arg.includes('Get-ScheduledTaskInfo'))) {
          observedQueryTimeouts.push(options?.timeout);
          // Model a successful but slow OS query; only an actual subprocess
          // deadline makes it fail. No wall-clock sleep or internal mock.
          if (options?.timeout && elapsedMs > options.timeout) {
            return { status: null, error: Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };
          }
        }
        return {
          status: 0,
          stdout: command === 'powershell.exe' ? '{"exists":true,"state":"Running"}' : '',
          stderr: '',
        };
      });
      await applyServicePlan(planServiceAction({
        backend: 'schtasks-user', action: 'restart', label: 'happier-daemon.default',
        taskName: 'Happier\\happier-daemon.default',
        definitionPath: join(directory, 'happier-daemon.default.ps1'),
      }));
      const inspect = () => inspectServiceRegistration({ backend: 'schtasks-user', label: 'happier-daemon.default' });
      if (queryTimesOut) expect(inspect).toThrow();
      else expect(inspect()).toBe('registered');
      expect(observedQueryTimeouts).toEqual([configuredTimeout ? Number(configuredTimeout) : undefined]);
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'powershell.exe')).toBe(true);
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'schtasks')).toBe(true);
      for (const [, , options] of spawnSyncMock.mock.calls) expect(options.windowsHide).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
