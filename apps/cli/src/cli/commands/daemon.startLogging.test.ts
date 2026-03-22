import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeTextFile } from '@/testkit/fs/fileHelpers';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const { checkIfDaemonRunningMock, getLatestDaemonLogMock } = vi.hoisted(() => ({
  checkIfDaemonRunningMock: vi.fn(async () => true),
  getLatestDaemonLogMock: vi.fn(async () => null as null | { path: string }),
}));

async function runDaemonStartAndCapture(expectedExitCode: number): Promise<string> {
  const output = captureConsoleText();

  try {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');
      await handleDaemonCliCommand({ args: ['daemon', 'start'], rawArgv: [], terminalRuntime: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes(`exit:${expectedExitCode}`)) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    return output.text();
  } finally {
    output.restore();
  }
}

function buildJwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.x`;
}

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: async () => ({ unref: () => {} }),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    checkIfDaemonRunningAndCleanupStaleState: () => checkIfDaemonRunningMock(),
  };
});

vi.mock('@/ui/logger', () => ({
  getLatestDaemonLog: () => getLatestDaemonLogMock(),
}));

describe('happier daemon start output', () => {
  beforeEach(() => {
    checkIfDaemonRunningMock.mockReset();
    checkIfDaemonRunningMock.mockResolvedValue(true);
    getLatestDaemonLogMock.mockReset();
    getLatestDaemonLogMock.mockResolvedValue(null);
  });

  it('prints server url, active server id, and account subject', async () => {
    // Defensive: other test files may enable fake timers and forget to restore them.
    // This command uses real setTimeout polling when the daemon isn't immediately detected.
    vi.useRealTimers();

    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
    ]);
    const tmp = await createTempDir('happier-daemon-start-');

    try {
      vi.resetModules();
      envScope.patch({
        HAPPIER_HOME_DIR: tmp,
        HAPPIER_SERVER_URL: 'http://localhost:4321',
        HAPPIER_WEBAPP_URL: 'http://localhost:9999',
        HAPPIER_ACTIVE_SERVER_ID: 'env_test',
      });

      const credDir = join(tmp, 'servers', 'env_test');
      await writeTextFile(
        join(credDir, 'access.key'),
        JSON.stringify(
          {
            encryption: { publicKey: Buffer.from('a').toString('base64'), machineKey: Buffer.from('b').toString('base64') },
            token: buildJwtWithSub('account-123'),
          },
          null,
          2,
        ),
      );

      const stdout = await runDaemonStartAndCapture(0);

      expect(stdout).toContain('Daemon started successfully');
      expect(stdout).toContain('Server: http://localhost:4321');
      expect(stdout).toContain('Server ID: env_test');
      expect(stdout).toContain('Account: account-123');
    } finally {
      envScope.restore();
      await removeTempDir(tmp);
    }
  }, 60_000);

  it('prints the daemon log path when startup does not succeed', async () => {
    vi.useRealTimers();
    checkIfDaemonRunningMock.mockResolvedValue(false);
    getLatestDaemonLogMock.mockResolvedValue({ path: '/tmp/happier-daemon.log' });

    const stdout = await runDaemonStartAndCapture(1);

    expect(stdout).toContain('Failed to start daemon');
    expect(stdout).toContain('/tmp/happier-daemon.log');
  }, 60_000);
});
