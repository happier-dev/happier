import { getPriority } from 'node:os';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scheduling priority is an OS boundary; keep the real launch policy underneath it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, getPriority: vi.fn(() => 0) };
});

import {
  buildSystemdUserScopedLaunchSpec,
  isSystemdUserResourceGovernorReady,
} from './systemdUserResourceGovernor';

describe('systemd user resource governor', () => {
  beforeEach(() => {
    vi.mocked(getPriority).mockReturnValue(0);
  });

  it('wraps an admitted runner in the disposable jobs slice, keeping it alive when one of its tools is OOM-killed, without imposing a CPU or memory cap', () => {
    const spec = buildSystemdUserScopedLaunchSpec({
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
        '--slice=happier-jobs.slice',
        '--nice=10',
        '--property=OOMPolicy=continue',
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
    ['an unweighted dynamic slice', {
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
