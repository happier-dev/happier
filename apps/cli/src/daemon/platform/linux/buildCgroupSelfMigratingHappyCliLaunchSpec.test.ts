import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { getPriority, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Scheduling priority is an OS boundary; exercise the real governor and launch composition.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, getPriority: vi.fn(() => 0) };
});

const mocks = vi.hoisted(() => ({
  execFileWithDeadline: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  execFileWithDeadline: mocks.execFileWithDeadline,
}));

import { buildCgroupSelfMigratingHappyCliLaunchSpec } from './buildCgroupSelfMigratingHappyCliLaunchSpec';

describe('buildCgroupSelfMigratingHappyCliLaunchSpec', () => {
  beforeEach(() => {
    vi.mocked(getPriority).mockReturnValue(0);
  });
  let sandboxDir: string | null = null;

  afterEach(async () => {
    if (!sandboxDir) return;
    await rm(sandboxDir, { recursive: true, force: true });
    sandboxDir = null;
  });

  afterEach(() => {
    mocks.execFileWithDeadline.mockReset();
    mocks.execFileWithDeadline.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('targets a sibling scope outside app.slice when the daemon runs as a user service', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-launch-spec-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '111');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );

    const result = await buildCgroupSelfMigratingHappyCliLaunchSpec({
      args: ['codex', '--happy-starting-mode', 'remote'],
      daemonPid: 111,
      procfsRootDir,
    });

    expect(result?.filePath).toBe('/bin/sh');
    expect(result?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toBe(
      '/sys/fs/cgroup/user.slice/user-501.slice/user@501.service',
    );
    expect(result?.args.join(' ')).toContain('happier-session-$$.scope');

    const shellScript = result?.args[1] ?? '';
    expect(shellScript).toContain('exec "$@"');
    expect(shellScript).toContain('|| true');
  });

  it('wraps the admitted immutable runner decision without recomputing the child entrypoint', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-immutable-launch-spec-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '222');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );
    const immutableEntrypoint = '/runtime/.runner-snapshots/0123456789abcdef/index.mjs';

    const result = await buildCgroupSelfMigratingHappyCliLaunchSpec({
      args: ['codex', '--happy-terminal-mode', 'plain'],
      daemonPid: 222,
      procfsRootDir,
      launchOptions: {
        runtimeDecision: {
          runtime: 'node',
          argvPrefix: ['--no-warnings', '--no-deprecation', immutableEntrypoint],
          env: { HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' },
        },
      },
    });

    expect(result?.args).toEqual(expect.arrayContaining([
      immutableEntrypoint,
      'codex',
      '--happy-terminal-mode',
      'plain',
    ]));
    expect(result?.env).toMatchObject({
      HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef',
    });
  });

  it('uses the provisioned lower-weight jobs slice instead of the daemon control-plane slice', async () => {
    vi.mocked(getPriority).mockReturnValue(19);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mocks.execFileWithDeadline.mockResolvedValue({
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=60129542144\n',
      stderr: '',
    });

    try {
      const result = await buildCgroupSelfMigratingHappyCliLaunchSpec({
        args: ['codex', '--happy-starting-mode', 'remote'],
        daemonPid: 333,
        procfsRootDir: '/proc-that-is-not-used-when-systemd-is-ready',
        environment: {
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
        },
      });

      expect(result?.filePath).toBe('systemd-run');
      expect(result?.args).toEqual(expect.arrayContaining([
        '--user',
        '--scope',
        '--slice=happier-jobs.slice',
        '--nice=19',
        '--',
        'codex',
      ]));
      expect(result?.args.join(' ')).not.toMatch(/MemoryMax|MemoryHigh|MemoryLimit|OOM/u);
      expect(result?.env?.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).toBe('');
      expect(mocks.execFileWithDeadline).toHaveBeenCalledWith(
        'systemctl',
        [
          '--user',
          'show',
          'happier-jobs.slice',
          '--property=LoadState',
          '--property=CPUWeight',
          '--property=IOWeight',
          '--property=MemoryHigh',
        ],
        expect.objectContaining({
          env: expect.objectContaining({
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
          }),
        }),
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it('keeps the legacy self-migrating scope when the provisioned user slice is unavailable', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-launch-spec-fallback-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '444');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );
    mocks.execFileWithDeadline.mockResolvedValue({
      stdout: 'LoadState=loaded\nMemoryLow=0\n',
      stderr: '',
    });

    try {
      const result = await buildCgroupSelfMigratingHappyCliLaunchSpec({
        args: ['codex'],
        daemonPid: 444,
        procfsRootDir,
        environment: {
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
        },
      });

      expect(result?.filePath).toBe('/bin/sh');
      expect(result?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toBe(
        '/sys/fs/cgroup/user.slice/user-501.slice/user@501.service',
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
