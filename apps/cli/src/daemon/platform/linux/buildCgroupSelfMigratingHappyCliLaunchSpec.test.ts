import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { getPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

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

import { buildCgroupProcessLaunchSpec, buildCgroupSelfMigratingHappyCliLaunchSpec, prepareCgroupProcessLaunchScope } from './buildCgroupSelfMigratingHappyCliLaunchSpec';

describe('buildCgroupSelfMigratingHappyCliLaunchSpec', () => {
  beforeEach(() => {
    vi.mocked(getPriority).mockReturnValue(0);
  });
  let sandboxDir: string | null = null;

  it('uses an available user manager for ordinary launches without a jobs governor or memory controller', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-ordinary-user-scope-'));
    const systemdRunPath = join(sandboxDir, 'systemd-run');
    const managerControlGroup = `/happier-no-memory-controller-${sandboxDir.split('/').at(-1)}`;
    await expect(readFile(`/sys/fs/cgroup${managerControlGroup}/cgroup.controllers`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(systemdRunPath, '#!/bin/sh\n', { mode: 0o755 });
    const execFile = vi.fn(async (command: string, args: readonly string[]) => ({
      stdout: command === systemdRunPath ? '--expand-environment='
        : args.includes('--property=ControlGroup') ? `ControlGroup=${managerControlGroup}\n`
          : 'LoadState=loaded\nCPUWeight=[not set]\nIOWeight=[not set]\nMemoryHigh=infinity\n',
      stderr: '',
    }));
    const scope = await prepareCgroupProcessLaunchScope({
      environment: { PATH: sandboxDir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus' },
      procfsRootDir: '/unused-procfs', systemdUserResourceGovernorExecFile: execFile,
    });
    expect(scope).toMatchObject({ kind: 'systemd', systemdRunPath });
    if (!scope) throw new Error('Ordinary Session scope is required when the user manager is available');
    const result = buildCgroupProcessLaunchSpec({ scope, unit: 'owned.scope', launchSpec: { filePath: '/target', args: [] } });
    expect(result.args).toContain('--unit=owned.scope');
    expect(result.args.join(' ')).not.toMatch(/MemoryHigh|MemoryMax|MemoryAccounting/);
    // One launch-time manager observation; no poll or memory-controller requirement.
    expect(execFile.mock.calls.filter(([, args]) => args.includes('--property=ControlGroup'))).toHaveLength(1);
  });

  it.each(['missing', '0::/\n', '2:memory:/legacy\n'])('refuses an explicit ceiling without a usable scope (%j), retaining optional unbounded fallback', async cgroup => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-ceiling-no-scope-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    if (cgroup !== 'missing') {
      await mkdir(join(procfsRootDir, '111'), { recursive: true });
      await writeFile(join(procfsRootDir, '111', 'cgroup'), cgroup);
    }
    const params = { daemonPid: 111, procfsRootDir, environment: { PATH: sandboxDir },
      systemdUserResourceGovernorExecFile: async () => { throw new Error('No user manager'); } };
    await expect(prepareCgroupProcessLaunchScope({ ...params, memoryHighBytes: 1073741824 }))
      .rejects.toMatchObject({ code: 'SPAWN_VALIDATION_FAILED' });
    await expect(buildCgroupSelfMigratingHappyCliLaunchSpec({ ...params,
      launchSpec: { runtime: 'node', filePath: '/unused-target', args: [] }, memoryHighBytes: 1073741824 }))
      .rejects.toMatchObject({ code: 'SPAWN_VALIDATION_FAILED' });
    await expect(prepareCgroupProcessLaunchScope(params)).resolves.toBeNull();
    await expect(prepareCgroupProcessLaunchScope({ ...params, memoryHighBytes: null })).resolves.toBeNull();
  });

  it.each(['file', 'not writable'] as const)('runs the target without scope diagnostics when the optional cgroup parent is %s', async (state) => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-unavailable-'));
    const baseDir = join(sandboxDir, 'cgroup');
    if (state === 'file') {
      await writeFile(baseDir, 'not a delegated directory');
    } else {
      await mkdir(baseDir);
      await chmod(baseDir, 0o500);
    }
    const spec = buildCgroupProcessLaunchSpec({ scope: { kind: 'cgroup', baseDir },
      launchSpec: { filePath: '/bin/sh', args: ['-c', 'printf "target output"; printf "target error" >&2'] },
    });
    const result = await promisify(execFile)(spec.filePath, spec.args, { env: { ...process.env, ...spec.env } });
    expect(result.stdout).toBe('target output');
    expect(result.stderr).toBe('target error');
  });

  it('sets the selected soft ceiling before the self-migrated target runs', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-ceiling-launch-'));
    const unit = 'happier-session-0123456789ab.session-123-nonce.scope';
    const scopeDir = join(sandboxDir, unit);
    await mkdir(scopeDir);
    await writeFile(join(scopeDir, 'memory.high'), 'max');
    const spec = buildCgroupProcessLaunchSpec({
      scope: { kind: 'cgroup', baseDir: sandboxDir }, unit, memoryHighBytes: 1048576,
      launchSpec: { filePath: '/bin/sh', args: ['-c', 'test "$(cat "$HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR/$HAPPIER_DAEMON_PROCESS_CGROUP_UNIT/memory.high")" = 1048576'] },
    });
    await promisify(execFile)(spec.filePath, spec.args, { env: { ...process.env, ...spec.env } });
    expect(await readFile(join(scopeDir, 'memory.high'), 'utf8')).toBe('1048576\n');
  });

  it.each(['create', 'enter'] as const)('refuses a configured-ceiling launch when the runner cannot %s its scope', async (failure) => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-ceiling-launch-'));
    const unit = 'happier-session-0123456789ab.session-123-nonce.scope';
    const baseDir = join(sandboxDir, 'cgroup');
    if (failure === 'create') await writeFile(baseDir, 'not a delegated directory');
    else await mkdir(join(baseDir, unit, 'cgroup.procs'), { recursive: true });
    const spec = buildCgroupProcessLaunchSpec({ scope: { kind: 'cgroup', baseDir }, unit, memoryHighBytes: 1048576,
      launchSpec: { filePath: '/bin/sh', args: ['-c', 'exit 0'] } });
    await expect(promisify(execFile)(spec.filePath, spec.args, { env: { ...process.env, ...spec.env } })).rejects.toThrow();
  });

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
      unit: 'happier-session-0123456789ab.session-123-nonce.scope',
      args: ['codex', '--happy-starting-mode', 'remote'],
      daemonPid: 111,
      procfsRootDir,
    });

    expect(result?.filePath).toBe('/bin/sh');
    expect(result?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toBe(
      '/sys/fs/cgroup/user.slice/user-501.slice/user@501.service',
    );
    expect(result?.env?.HAPPIER_DAEMON_PROCESS_CGROUP_UNIT).toBe('happier-session-0123456789ab.session-123-nonce.scope');
    expect(result?.args.join(' ')).toContain('$HAPPIER_DAEMON_PROCESS_CGROUP_UNIT');

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
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-systemd-launch-spec-'));
    const systemdRunPath = join(sandboxDir, 'systemd-run');
    await writeFile(systemdRunPath, '#!/bin/sh\n', { mode: 0o755 });
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
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
          PATH: sandboxDir,
        },
      });

      expect(result?.filePath).toBe(systemdRunPath);
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
          ...process.env,
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
