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

describe('happier daemon service', () => {
  it('supports -h as help flag', async () => {
    const stdout = await captureStdout(async () => {
      await handleDaemonCliCommand({
        args: ['daemon', 'service', '-h'],
        rawArgv: [],
        terminalRuntime: null,
      });
    });

    expect(stdout).toContain('happier daemon service');
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('happier daemon service status [--json]');
  });

  it('prints resolved service paths as JSON', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-daemon-service-'));
    const prevPlatform = process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
    const prevUserHome = process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
    const prevHappyHome = process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
    const prevInstanceId = process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;

    try {
      process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
      process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = tmp;
      process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(tmp, '.happier');
      process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = 'cloud';

      const stdout = await captureStdout(async () => {
        await handleDaemonCliCommand({
          args: ['daemon', 'service', 'paths', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });
      });

      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; paths?: { unitPath?: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.paths?.unitPath).toBe(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.cloud.service'));
    } finally {
      if (prevPlatform === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
      else process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = prevPlatform;
      if (prevUserHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = prevUserHome;
      if (prevHappyHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = prevHappyHome;
      if (prevInstanceId === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
      else process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = prevInstanceId;

      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('prints an install plan in --dry-run --json without writing files', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-daemon-service-'));
    const prevPlatform = process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
    const prevUserHome = process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
    const prevHappyHome = process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
    const prevInstanceId = process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;

    try {
      process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
      process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = tmp;
      process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(tmp, '.happier');
      process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = 'cloud';

      const unitPath = join(tmp, '.config', 'systemd', 'user', 'happier-daemon.cloud.service');

      const stdout = await captureStdout(async () => {
        await handleDaemonCliCommand({
          args: ['daemon', 'service', 'install', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });
      });

      const parsed = JSON.parse(stdout.trim()) as {
        ok: boolean;
        plan?: { files?: Array<{ path: string }>; commands?: Array<{ cmd: string; args: string[] }> };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.plan?.files?.[0]?.path).toBe(unitPath);
      expect(parsed.plan?.commands?.some((c) => c.cmd === 'systemctl')).toBe(true);

      // Dry-run: do not write to disk
      const { existsSync } = await import('node:fs');
      expect(existsSync(unitPath)).toBe(false);
    } finally {
      if (prevPlatform === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
      else process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = prevPlatform;
      if (prevUserHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = prevUserHome;
      if (prevHappyHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = prevHappyHome;
      if (prevInstanceId === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
      else process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = prevInstanceId;

      await rm(tmp, { recursive: true, force: true });
    }
  });
});
