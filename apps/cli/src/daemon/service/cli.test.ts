import { afterEach, describe, expect, it, vi } from 'vitest';

const SCOPED_ENV_KEYS = [
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  'HAPPIER_HOME_DIR',
  'PATH',
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

async function loadCliModule(): Promise<typeof import('./cli.js')> {
  return import('./cli.js');
}

describe('runDaemonServiceCliCommand', () => {
  const envBaseline = captureScopedEnv();

  afterEach(() => {
    restoreScopedEnv(envBaseline);
    vi.restoreAllMocks();
    vi.unmock('node:child_process');
    vi.unmock('node:os');
    vi.resetModules();
  });

  it('treats -h as help (not as a subcommand)', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'darwin';
    process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = '/tmp';
    process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = '/tmp/happier';

    const { stdout, stderr } = captureStdIo();

    await runDaemonServiceCliCommand({ argv: ['-h'] });

    expect(stdout.join('')).toContain('Usage:');
    expect(stderr.join('')).not.toContain('Unknown daemon service subcommand');
  });

  it('supports help JSON output', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
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

  it('treats --mode system as a flag (not as a subcommand) and reports systemd system paths (linux)', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
    process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = '/tmp';
    process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = '/tmp/happier';

    const { stdout } = captureStdIo();
    await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

    const payload = JSON.parse(stdout.join('').trim()) as {
      ok: boolean;
      platform: string;
      paths: { unitPath?: string; unitName?: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.platform).toBe('linux');
    expect(payload.paths.unitPath).toContain('/etc/systemd/system/');
    expect(payload.paths.unitName).toContain('happier-daemon.');
  });

  it('rejects invalid --mode values', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--mode', 'systm'] })).rejects.toThrow(
      'Invalid --mode value "systm" (expected user|system)',
    );
  });

  it('uses the target linux system user home for system install planning and log paths', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: vi.fn(() => ({
          pid: 1,
          output: ['', 'happier:x:1001:1001::/home/happier:/bin/bash\n', ''],
          stdout: 'happier:x:1001:1001::/home/happier:/bin/bash\n',
          stderr: '',
          status: 0,
          signal: null,
        })),
      };
    });
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        homedir: vi.fn(() => '/root'),
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
    process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID = 'company';
    process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH = '/usr/local/bin/happier';
    process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH = '';
    process.env.PATH = '/usr/bin';

    const processWithGetuid = process as typeof process & { getuid: () => number };
    vi.spyOn(processWithGetuid, 'getuid').mockReturnValue(0);
    const installIo = captureStdIo();
    await runDaemonServiceCliCommand({
      argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'],
    });

    const installPayload = JSON.parse(installIo.stdout.join('').trim()) as {
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    };

    expect(installPayload.ok).toBe(true);
    expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.company.service');
    expect(installPayload.plan.files[0]?.content).toContain('User=happier');
    expect(installPayload.plan.files[0]?.content).toContain('WorkingDirectory=/home/happier');
    expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_HOME_DIR=/home/happier/.happier');
    expect(installPayload.plan.files[0]?.content).toContain('Environment=PATH=');
    expect(installPayload.plan.files[0]?.content).toContain('/home/happier/.local/bin');
    expect(installPayload.plan.files[0]?.content).toContain('/home/happier/bin');
    expect(installPayload.plan.files[0]?.content).not.toContain('/root/.local/bin');
    expect(installPayload.plan.files[0]?.content).not.toContain('/root/.happier');

    const pathsIo = captureStdIo();
    await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

    const pathsPayload = JSON.parse(pathsIo.stdout.join('').trim()) as {
      ok: boolean;
      paths: { stdoutPath?: string; stderrPath?: string };
    };

    expect(pathsPayload.ok).toBe(true);
    expect(pathsPayload.paths.stdoutPath).toBe('/home/happier/.happier/logs/daemon-service.company.out.log');
    expect(pathsPayload.paths.stderrPath).toBe('/home/happier/.happier/logs/daemon-service.company.err.log');
  });
});
