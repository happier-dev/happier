import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStderr, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { dispatchCli } from './dispatch';

describe('dispatchCli prefix server selection failures', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let exitSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let previousExitCode: number | string | null | undefined;

  beforeEach(() => {
    envScope = createEnvKeyScope(envKeys);
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    envScope.restore();
    reloadConfiguration();
    process.exitCode = previousExitCode;
  });

  it('returns one JSON dispatch error for an invalid prefix server selection', async () => {
    const stdout = captureStdoutJsonOutput<{
      v: number;
      ok: boolean;
      kind: string;
      error?: { code?: string; message?: string };
    }>();
    const stderr = captureStderr();
    try {
      await withTempDir('happier-cli-dispatch-server-selection-', async (homeDir) => {
        envScope.patch({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined,
          HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: undefined,
        });
        reloadConfiguration();

        await dispatchCli({
          args: ['--server', 'missing-server-profile', 'capabilities', '--json'],
          rawArgv: ['happier', '--server', 'missing-server-profile', 'capabilities', '--json'],
          terminalRuntime: null,
        });
      });

      expect(stdout.chunks).toHaveLength(1);
      expect(stdout.json()).toMatchObject({
        v: 1,
        ok: false,
        kind: 'cli_dispatch',
        error: {
          code: 'invalid_arguments',
          message: 'Server profile not found: missing-server-profile',
        },
      });
      expect(stderr.text()).toBe('');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  it('keeps the human error and exit behavior without --json', async () => {
    const stdout = captureStdoutJsonOutput();
    const stderr = captureStderr();
    try {
      await withTempDir('happier-cli-dispatch-server-selection-', async (homeDir) => {
        envScope.patch({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined,
          HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: undefined,
        });
        reloadConfiguration();

        await dispatchCli({
          args: ['--server', 'missing-server-profile', 'capabilities'],
          rawArgv: ['happier', '--server', 'missing-server-profile', 'capabilities'],
          terminalRuntime: null,
        });
      });

      expect(stdout.chunks).toHaveLength(0);
      expect(stderr.text()).toBe('');
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Server profile not found: missing-server-profile'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });
});
