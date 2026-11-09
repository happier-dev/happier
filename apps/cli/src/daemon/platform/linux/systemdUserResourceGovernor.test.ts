import { getPriority } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scheduling priority is an OS boundary; keep real launch policy underneath it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, getPriority: vi.fn(() => 0) };
});

import {
  buildSystemdUserScopedLaunchSpec,
  createHappierLinuxScopeName,
  parseHappierLinuxScopeName,
  isSystemdUserResourceGovernorReady,
  readGuardCeilingCapability,
  setGuardSessionMemoryHigh,
  shouldUseSystemdUserSessionResourceGovernor,
} from './systemdUserResourceGovernor';

describe('systemd user resource governor', () => {
  it('retains a launch-owned exit capture inside an unbounded Session scope without changing native policy or collection', () => {
    const spec = buildSystemdUserScopedLaunchSpec({
      unit: 'owned.scope',
      sessionExitCapture: { executable: '/opt/happier/happier-process-custody', evidencePath: '/private/exact-exit.json' },
      launchSpec: { filePath: '/opt/happier/happier', args: ['codex', 'opaque $input'] },
    });
    const target = spec.args.slice(spec.args.indexOf('--') + 1);
    expect(target).toEqual(['/opt/happier/happier-process-custody', 'scope-exec', '--unit=owned.scope',
      '--evidence=/private/exact-exit.json', '--', '/opt/happier/happier', 'codex', 'opaque $input']);
    expect(spec.args).toContain('--collect');
    expect(spec.args.join(' ')).not.toMatch(/OOMPolicy|MemoryMax|MemoryHigh/);
  });
  it('reports a ceiling only after the user manager and its actual memory controller are observed', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'ControlGroup=/user.slice/user-1000.slice/user@1000.service\n', stderr: '' }));
    const readFile = vi.fn(async () => 'cpu io memory pids\n');
    await expect(readGuardCeilingCapability({ platform: 'linux', environment: {}, execFile, readFile }))
      .resolves.toEqual({ status: 'available' });
    expect(readFile).toHaveBeenCalledWith('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers', 'utf8');
    readFile.mockResolvedValue('cpu io pids\n');
    await expect(readGuardCeilingCapability({ platform: 'linux', execFile, readFile }))
      .resolves.toEqual({ status: 'unavailable', reason: 'no_memory_controller' });
    readFile.mockRejectedValue(new Error('unreadable delegated controllers'));
    await expect(readGuardCeilingCapability({ platform: 'linux', execFile, readFile }))
      .resolves.toEqual({ status: 'unavailable', reason: 'no_memory_controller' });
    // systemd's Manager API represents a cgroup-namespace root as the empty string.
    execFile.mockResolvedValue({ stdout: 'ControlGroup=\n', stderr: '' }); readFile.mockResolvedValue('memory\n');
    await expect(readGuardCeilingCapability({ platform: 'linux', execFile, readFile })).resolves.toEqual({ status: 'available' });
    expect(readFile).toHaveBeenLastCalledWith('/sys/fs/cgroup/cgroup.controllers', 'utf8');
  });

  it('does not trust a platform or bus hint when the real user manager is unavailable', async () => {
    const execFile = vi.fn(async () => { throw new Error('Failed to connect to bus'); });
    const readFile = vi.fn(async () => 'memory\n');
    await expect(readGuardCeilingCapability({ platform: 'darwin', execFile, readFile }))
      .resolves.toEqual({ status: 'unavailable', reason: 'not_linux' });
    await expect(readGuardCeilingCapability({ platform: 'win32', execFile, readFile }))
      .resolves.toEqual({ status: 'unavailable', reason: 'not_linux' });
    expect(execFile).not.toHaveBeenCalled();
    await expect(readGuardCeilingCapability({ platform: 'linux', environment: { DBUS_SESSION_BUS_ADDRESS: 'hint' }, execFile, readFile }))
      .resolves.toEqual({ status: 'unavailable', reason: 'no_user_manager' });
    expect(readFile).not.toHaveBeenCalled();
  });
  it('round trips home-scoped opaque owner ids through canonical systemd byte escaping', () => {
    const name = createHappierLinuxScopeName('v1.0123456789ab.service..a-b/é\\@:_');
    expect(name).toMatch(/^happier-service-0123456789ab\.\\x2ea\\x2db-\\xc3\\xa9\\x5c\\x40:_-[0-9a-f]{32}\.scope$/);
    expect(parseHappierLinuxScopeName(name!)).toMatchObject({ daemonScopeKey: '0123456789ab', owner: { kind: 'service', serviceId: '.a-b/é\\@:_' } });
    expect(parseHappierLinuxScopeName(`/foreign/${name}`)).toBeNull();
    expect(parseHappierLinuxScopeName(name!.replace('\\x2d', '-'))?.owner).not.toEqual({ kind: 'service', serviceId: '.a-b/é\\@:_' });
    expect(parseHappierLinuxScopeName(name!.replace('\\xc3\\xa9', '\\xff'))).toBeNull();
    expect(createHappierLinuxScopeName('foreign')).toBeUndefined();
    expect(createHappierLinuxScopeName('v1.0123456789ab.service..a-b/é\\@:_')).not.toBe(name);
  });
  beforeEach(() => {
    vi.mocked(getPriority).mockReturnValue(0);
  });

  it.each([
    ['linux background service', 'linux', 'background-service', true],
    ['linux self-restart', 'linux', 'self-restart', true],
    ['linux manual daemon', 'linux', 'manual', true],
    ['non-linux self-restart', 'darwin', 'self-restart', false],
    ['Windows manual daemon', 'win32', 'manual', false],
  ] as const)('selects the session governor for %s', (_label, platform, startupSource, expected) => {
    expect(shouldUseSystemdUserSessionResourceGovernor({ platform, startupSource })).toBe(expected);
  });

  it('wraps an admitted agent session in the lower-weight jobs slice without imposing a cap', () => {
    const spec = buildSystemdUserScopedLaunchSpec({
      unit: 'happier-session-0123456789ab.session-123-nonce.scope',
      launchSpec: {
        filePath: '/opt/happier/runtime/bin/happier-js-runtime',
        args: [
          '--no-warnings',
          '/opt/happier/.runner-snapshots/immutable/index.mjs',
          'codex',
          '--happy-starting-mode',
          'remote',
        ],
        env: { HAPPIER_TEST_ADMITTED_CLOSURE: 'immutable' },
      },
    });

    expect(spec).toEqual({
      filePath: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--unit=happier-session-0123456789ab.session-123-nonce.scope',
        '--slice=happier-jobs.slice',
        '--nice=10',
        '--',
        '/opt/happier/runtime/bin/happier-js-runtime',
        '--no-warnings',
        '/opt/happier/.runner-snapshots/immutable/index.mjs',
        'codex',
        '--happy-starting-mode',
        'remote',
      ],
      env: { HAPPIER_TEST_ADMITTED_CLOSURE: 'immutable' },
    });
    expect(spec.args.join(' ')).not.toMatch(/CPUQuota|MemoryMax|MemoryHigh|TasksMax/u);
  });

  it('preserves an inherited lower scheduling priority instead of requiring permission to raise it', () => {
    vi.mocked(getPriority).mockReturnValue(19);
    const spec = buildSystemdUserScopedLaunchSpec({
      launchSpec: { filePath: '/opt/happier/runtime/bin/happier-js-runtime', args: ['claude'] },
    });

    expect(spec.args).toContain('--nice=19');
    expect(spec.args).not.toContain('--nice=10');
  });

  it('applies a selected Session soft ceiling to the admitted scope without a hard-kill limit', async () => {
    const spec = buildSystemdUserScopedLaunchSpec({
      unit: 'happier-session-0123456789ab.session-123-nonce.scope',
      properties: ['MemoryAccounting=yes', 'MemoryHigh=1048576'],
      launchSpec: { filePath: '/opt/happier/happier', args: ['claude'] },
    });
    expect(spec.args).toEqual(expect.arrayContaining(['-p', 'MemoryAccounting=yes', 'MemoryHigh=1048576']));
    expect(spec.args.indexOf('MemoryHigh=1048576')).toBeLessThan(spec.args.indexOf('--'));
    expect(spec.args.join(' ')).not.toContain('MemoryMax');
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await setGuardSessionMemoryHigh({ unit: 'owned.scope', bytes: 1048576, execFile });
    await setGuardSessionMemoryHigh({ unit: 'owned.scope', bytes: null, execFile });
    expect(execFile.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['systemctl', ['--user', 'set-property', '--runtime', 'owned.scope', 'MemoryHigh=1048576']],
      ['systemctl', ['--user', 'set-property', '--runtime', 'owned.scope', 'MemoryHigh=infinity']],
    ]);
  });

  it('only enables the Linux wrapper when the provisioned jobs slice has its expected shares and finite soft memory boundary', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=60129542144\n',
      stderr: '',
    }));

    await expect(isSystemdUserResourceGovernorReady({
      platform: 'linux',
      environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus' },
      execFile,
    })).resolves.toBe(true);

    expect(execFile).toHaveBeenCalledWith(
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
        timeout: 1_000,
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus' },
      }),
    );
  });

  it.each([
    ['a non-Linux platform', { platform: 'darwin' as const, environment: { DBUS_SESSION_BUS_ADDRESS: 'x' }, stdout: '' }],
    ['no user-systemd bus', { platform: 'linux' as const, environment: {}, stdout: '' }],
    ['a jobs slice without its configured shares', {
      platform: 'linux' as const,
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      stdout: 'LoadState=loaded\nCPUWeight=100\nIOWeight=100\n',
    }],
    ['a jobs slice without a finite soft memory boundary', {
      platform: 'linux' as const,
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=infinity\n',
    }],
  ])('fails closed for %s', async (_label, fixture) => {
    const execFile = vi.fn(async () => ({ stdout: fixture.stdout ?? '', stderr: '' }));

    await expect(isSystemdUserResourceGovernorReady({
      platform: fixture.platform,
      environment: fixture.environment,
      execFile,
    })).resolves.toBe(false);
  });
});
