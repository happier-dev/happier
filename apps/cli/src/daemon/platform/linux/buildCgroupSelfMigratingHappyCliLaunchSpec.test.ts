import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  systemdResourceGovernorExecFile: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

import { buildCgroupSelfMigratingHappyCliLaunchSpec } from './buildCgroupSelfMigratingHappyCliLaunchSpec';

describe('buildCgroupSelfMigratingHappyCliLaunchSpec', () => {
  let sandboxDir: string | null = null;

  afterEach(async () => {
    if (!sandboxDir) return;
    await rm(sandboxDir, { recursive: true, force: true });
    sandboxDir = null;
  });

  afterEach(() => {
    mocks.systemdResourceGovernorExecFile.mockReset();
    mocks.systemdResourceGovernorExecFile.mockResolvedValue({ stdout: '', stderr: '' });
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
      systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
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
      systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
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

  it('uses the provisioned lower-weight user slice as the canonical session launch owner', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mocks.systemdResourceGovernorExecFile.mockResolvedValue({
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\n',
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
        systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
      });

      expect(result?.filePath).toBe('systemd-run');
      expect(result?.args).toEqual(expect.arrayContaining([
        '--user',
        '--scope',
        '--slice=happier-jobs.slice',
        '--nice=10',
        '--',
        'codex',
      ]));
      expect(result?.args.join(' ')).not.toMatch(/MemoryMax|MemoryHigh|MemoryLimit|OOM/u);
      expect(result?.env?.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).toBe('');
      expect(mocks.systemdResourceGovernorExecFile).toHaveBeenCalledWith(
        'systemctl',
        [
          '--user',
          'show',
          'happier-jobs.slice',
          '--property=LoadState',
          '--property=CPUWeight',
          '--property=IOWeight',
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
    mocks.systemdResourceGovernorExecFile.mockResolvedValue({
      stdout: 'LoadState=loaded\nCPUWeight=100\nIOWeight=100\n',
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
        systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
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
