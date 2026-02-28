import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleDaemonCliCommand } from './daemon';

async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(
    ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      if (typeof encoding === 'function') {
        encoding(null);
      } else if (typeof callback === 'function') {
        callback(null);
      }
      return true;
    }) as typeof process.stdout.write,
  );
  try {
    await fn();
    return chunks.join('');
  } finally {
    writeSpy.mockRestore();
  }
}

describe('happier daemon install/uninstall', () => {
  it('aliases daemon install to daemon service install (supports --dry-run --json)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-daemon-install-alias-'));
    const tmpBin = join(tmp, 'bin');
    const prevPlatform = process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
    const prevUserHome = process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
    const prevHappyHome = process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
    const prevInstanceId = process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
    const prevHome = process.env.HOME;
    const prevPath = process.env.PATH;

    try {
      process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
      process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = tmp;
      process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(tmp, '.happier');
      process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = 'cloud';
      // Ensure the legacy (non-service) daemon install path doesn't execute launchctl/systemctl
      // during RED. We keep PATH empty so planned commands are skipped.
      process.env.HOME = tmp;
      process.env.PATH = tmpBin;

      const stdout = await captureStdout(async () => {
        await handleDaemonCliCommand({
          args: ['daemon', 'install', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });
      });

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; plan?: { files?: Array<{ path: string }> } };
      expect(parsed.ok).toBe(true);
      expect(parsed.plan?.files?.[0]?.path).toContain('happier-daemon.cloud.service');
    } finally {
      if (prevPlatform === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
      else process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = prevPlatform;
      if (prevUserHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = prevUserHome;
      if (prevHappyHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = prevHappyHome;
      if (prevInstanceId === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
      else process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = prevInstanceId;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;

      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('aliases daemon uninstall to daemon service uninstall (supports --dry-run --json)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-daemon-uninstall-alias-'));
    const tmpBin = join(tmp, 'bin');
    const prevPlatform = process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
    const prevUserHome = process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
    const prevHappyHome = process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
    const prevInstanceId = process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
    const prevHome = process.env.HOME;
    const prevPath = process.env.PATH;

    try {
      process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
      process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = tmp;
      process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(tmp, '.happier');
      process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = 'cloud';
      process.env.HOME = tmp;
      process.env.PATH = tmpBin;

      const stdout = await captureStdout(async () => {
        await handleDaemonCliCommand({
          args: ['daemon', 'uninstall', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });
      });

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; plan?: { filesToRemove?: string[] } };
      expect(parsed.ok).toBe(true);
      expect(parsed.plan?.filesToRemove?.some((p) => p.includes('happier-daemon.cloud.service'))).toBe(true);
    } finally {
      if (prevPlatform === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
      else process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = prevPlatform;
      if (prevUserHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = prevUserHome;
      if (prevHappyHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = prevHappyHome;
      if (prevInstanceId === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
      else process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = prevInstanceId;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;

      await rm(tmp, { recursive: true, force: true });
    }
  });
});
