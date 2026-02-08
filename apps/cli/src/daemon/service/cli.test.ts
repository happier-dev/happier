import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDaemonServiceCliCommand } from './cli';

const SCOPED_ENV_KEYS = [
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
] as const;

type ScopedEnvKey = (typeof SCOPED_ENV_KEYS)[number];

function captureScopedEnv(): Record<ScopedEnvKey, string | undefined> {
  return Object.fromEntries(
    SCOPED_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<ScopedEnvKey, string | undefined>;
}

function restoreScopedEnv(snapshot: Record<ScopedEnvKey, string | undefined>): void {
  for (const key of SCOPED_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function captureStdIo(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(
    ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      if (typeof encoding === 'function') encoding(null);
      else if (typeof callback === 'function') callback(null);
      return true;
    }) as typeof process.stdout.write,
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(
    ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      if (typeof encoding === 'function') encoding(null);
      else if (typeof callback === 'function') callback(null);
      return true;
    }) as typeof process.stderr.write,
  );
  return { stdout, stderr };
}

describe('runDaemonServiceCliCommand', () => {
  const envBaseline = captureScopedEnv();

  afterEach(() => {
    restoreScopedEnv(envBaseline);
    vi.restoreAllMocks();
  });

  it('treats -h as help (not as a subcommand)', async () => {
    process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'darwin';
    process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = '/tmp';
    process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = '/tmp/happier';

    const { stdout, stderr } = captureStdIo();

    await runDaemonServiceCliCommand({ argv: ['-h'] });

    expect(stdout.join('')).toContain('Usage:');
    expect(stderr.join('')).not.toContain('Unknown daemon service subcommand');
  });

  it('supports help JSON output', async () => {
    process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'darwin';
    process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = '/tmp';
    process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = '/tmp/happier';

    const { stdout } = captureStdIo();
    await runDaemonServiceCliCommand({ argv: ['--help', '--json'] });

    const payload = JSON.parse(stdout.join('').trim()) as {
      ok: boolean;
      commands: string[];
      flags: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.commands).toContain('install');
    expect(payload.flags).toContain('--json');
  });
});
