import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

import { repoRootDir } from '../../src/testkit/paths';

import {
  createPlaywrightSpawnOptions,
  parseHeartbeatArgs,
  resolveSignalExitCode,
} from '../../scripts/runPlaywrightWithHeartbeat.shared.mjs';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('runPlaywrightWithHeartbeat helpers', () => {
  it('supports both config flag forms while preserving passthrough args', () => {
    expect(parseHeartbeatArgs(['node', 'script', '--config', 'playwright.ui.config.mjs', '--grep', 'tmux'])).toEqual({
      config: 'playwright.ui.config.mjs',
      passThrough: ['--grep', 'tmux'],
    });
    expect(parseHeartbeatArgs(['node', 'script', '--config=playwright.ui.config.mjs', '--reporter=line'])).toEqual({
      config: 'playwright.ui.config.mjs',
      passThrough: ['--reporter=line'],
    });
  });

  it('uses detached child processes for playwright runs on non-Windows platforms', () => {
    expect(createPlaywrightSpawnOptions({ TEST_FLAG: '1' })).toMatchObject({
      detached: process.platform !== 'win32',
      stdio: 'inherit',
      env: expect.objectContaining({
        PLAYWRIGHT_HTML_OPEN: 'never',
        TEST_FLAG: '1',
      }),
    });
  });

  it('assigns a per-process UI web export namespace when one is not provided', () => {
    const first = createPlaywrightSpawnOptions({ TEST_FLAG: '1' });
    const second = createPlaywrightSpawnOptions({ TEST_FLAG: '1' });

    expect(first.env).toEqual(expect.objectContaining({
      TEST_FLAG: '1',
    }));
    expect(second.env).toEqual(expect.objectContaining({
      TEST_FLAG: '1',
    }));
    expect(first.env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE).toBe(`playwright-ui-${process.pid}`);
    expect(second.env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE).toBe(`playwright-ui-${process.pid}`);
  });

  it('preserves an explicit UI web export namespace', () => {
    const options = createPlaywrightSpawnOptions({
      TEST_FLAG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: 'uiweb-explicit',
    });
    expect(options.env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE).toBe('uiweb-explicit');
  });

  it('wires playwright artifacts and HTML report output into the shared namespace', async () => {
    vi.stubEnv('CI', '1');
    vi.stubEnv('HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE', 'uiweb-explicit');

    const { default: config } = await import('../../playwright.ui.config.mjs');
    const expectedRootDir = resolve(repoRootDir(), '.project', 'logs', 'e2e', 'ui-playwright', 'uiweb-explicit');
    const expectedOutputDir = resolve(expectedRootDir, 'test-results');

    expect(config.outputDir).toBe(expectedOutputDir);

    const reporter = Array.isArray(config.reporter) ? config.reporter : [];
    const htmlReporter = reporter.find((entry: unknown) => Array.isArray(entry) && entry[0] === 'html');
    expect(htmlReporter).toEqual([
      'html',
      expect.objectContaining({
        open: 'never',
        outputFolder: resolve(expectedRootDir, 'html-report'),
      }),
    ]);
  });

  it('maps signals to conventional exit codes', () => {
    expect(resolveSignalExitCode('SIGINT')).toBe(130);
    expect(resolveSignalExitCode('SIGTERM')).toBe(143);
    expect(resolveSignalExitCode(null)).toBe(1);
  });

  it('sweeps stale lease-owned processes before and after the wrapped child run', async () => {
    const events: string[] = [];
    const sweepStaleProcessOwnershipLeases = vi.fn(async () => {
      events.push('sweep');
    });
    const runManagedChildCommand = vi.fn(async () => {
      events.push('run');
      return {
        child: { pid: 12345 },
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
      };
    });

    vi.doMock('../../scripts/managedChildLifecycle.mjs', () => ({
      installParentDeathCleanupWatchdog: () => () => {},
      resolveSignalExitCode: (signal: string | null) => (signal === 'SIGINT' ? 130 : 1),
      runManagedChildCommand,
    }));
    vi.doMock('../../scripts/sweepProcessOwnershipLeases.mjs', () => ({
      sweepStaleProcessOwnershipLeases,
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? ''}`);
    }) as never);

    const { runHeartbeatWrappedCommand } = await import('../../scripts/runPlaywrightWithHeartbeat.shared.mjs');

    await expect(runHeartbeatWrappedCommand({
      command: 'yarn',
      args: ['-s', 'playwright', 'test'],
      config: 'playwright.ui.config.mjs',
      toolName: 'playwright',
      spawnOptions: createPlaywrightSpawnOptions({ CI: '1' }),
      resolveExitCode: () => 0,
    })).rejects.toThrow('process.exit:0');

    expect(events).toEqual(['sweep', 'run', 'sweep']);

    void logSpy;
    void errorSpy;
    void exitSpy;
  });
});
