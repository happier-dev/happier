import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('./commandExistsInPath', () => ({
  commandExistsInPath: vi.fn(() => true),
}));

describe('runDaemonServiceCommands', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    vi.restoreAllMocks();
    delete process.env.HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS;
  });

  it('keeps Linux manager preflight within the install deadline and preserves files when it expires', async () => {
    const { applyDaemonServiceInstallPlan } = await import('./apply');
    const dir = mkdtempSync(join(tmpdir(), 'happier-service-deadline-'));
    const path = join(dir, 'fresh.service');
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    spawnSyncMock.mockImplementation((_command: string, _args: readonly string[], options?: { timeout?: number }) => {
      expect(options?.timeout).toBe(100);
      now = 1_100;
      return { status: null, error: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }) };
    });
    const plan = { platform: 'linux' as const, files: [{ path, content: 'definition', mode: 0o644 }],
      commands: [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }] };
    try {
      await expect(applyDaemonServiceInstallPlan(plan, { deadlineMs: 1_100, commandFailureMode: 'strict' }))
        .rejects.toMatchObject({ code: 'service_start_timeout', serviceStepStatus: 'deadline_elapsed' });
      expect(existsSync(path)).toBe(false);
      spawnSyncMock.mockClear();
      await expect(applyDaemonServiceInstallPlan(plan, { deadlineMs: 1_100, commandFailureMode: 'strict' }))
        .rejects.toMatchObject({ code: 'service_start_timeout' });
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('restores state after an unavailable command and reports a restoration failure too', async () => {
    const { runDaemonServiceCommands } = await import('./apply');
    const { commandExistsInPath } = await import('./commandExistsInPath');
    vi.mocked(commandExistsInPath).mockImplementation(({ cmd }) => cmd !== 'missing');
    const executed: string[] = [];
    spawnSyncMock.mockImplementation((command: string) => {
      executed.push(command);
      return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('restoration denied') };
    });
    try {
      runDaemonServiceCommands([
        { cmd: 'missing', args: [] },
        { cmd: 'must-not-run', args: [] },
        { cmd: 'restore', args: [], runOnFailure: true },
      ], { failureMode: 'strict' });
      expect.fail('Expected both command failures');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const { readDaemonServiceFailureFacts } = await import('./failure');
      expect(readDaemonServiceFailureFacts(error)).toEqual({ error: 'service_manager_unavailable', serviceStep: 'command', serviceStepStatus: 'unavailable' });
      expect(String(error)).toMatch(/not available: missing/);
      expect(String(error)).toMatch(/restoration denied/);
    }
    expect(executed).toEqual(['restore']);
    vi.mocked(commandExistsInPath).mockReturnValue(true);
  });

  it.each(['darwin', 'win32'] as const)('restores disabled login state after a failed %s service restart', async (platform) => {
    const { runDaemonServiceCommands } = await import('./apply');
    const { planDaemonServiceInstall } = await import('./plan');
    let enabled = false;
    spawnSyncMock.mockImplementation((command: string, args: readonly string[] = []) => {
      if ((command === 'launchctl' && args[0] === 'enable') || (command === 'schtasks' && args[0] === '/Create')) enabled = true;
      if ((command === 'launchctl' && args[0] === 'disable') || (command === 'powershell.exe' && args.some((arg) => arg.includes('Disable-ScheduledTask')))) enabled = false;
      const failed = (command === 'launchctl' && args[0] === 'bootstrap') || (command === 'schtasks' && args[0] === '/Run');
      return { status: failed ? 1 : 0, stdout: Buffer.from(''), stderr: Buffer.from(failed ? 'restart denied' : '') };
    });
    const plan = planDaemonServiceInstall({
      platform, channel: 'stable', targetMode: 'pinned', instanceId: 'company', activeServerId: 'company',
      uid: 501, userHomeDir: '/test', happierHomeDir: '/test/.happier',
      serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test', publicServerUrl: 'https://company.example.test',
      nodePath: '/npm/happier', entryPath: '', enablement: 'disabled', preserveRunningWhenDisabled: true,
    });
    expect(() => runDaemonServiceCommands(plan.commands, { failureMode: 'strict' })).toThrow(/restart denied/);
    expect(enabled).toBe(false);
  });

  it('ignores missing launchctl bootout cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 3,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Boot-out failed: 3: No such process'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootout', 'gui/501/com.happier.cli.daemon.default'],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('ignores missing legacy systemd cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Failed to disable unit: Unit file happier-daemon.service does not exist.'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'disable', '--now', 'happier-daemon.service'],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('ignores missing suffixed systemd cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Failed to disable unit: Unit file happier-daemon.preview.default.service does not exist.'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'disable', '--now', 'happier-daemon.preview.default.service'],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('reports persistent launchctl kickstart absence in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 113,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['kickstart', '-k', 'gui/501/com.happier.cli.daemon.default'],
      },
    ], { failureMode: 'strict' })).toThrow(/Could not find service/);
  });

  it('still throws for non-benign launchctl failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Bootstrap failed: 5: Input/output error'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootstrap', 'gui/501', '/tmp/com.happier.cli.daemon.default.plist'],
      },
    ], { failureMode: 'strict' })).toThrow(/Background service command failed/);
  });

  it('ignores optional systemctl cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Failed to disable unit: Unit file happier-daemon.service does not exist.'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'disable', '--now', 'happier-daemon.service'],
        ignoreFailure: true,
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('sets the systemd user session environment for user-scoped systemctl commands', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockImplementation((_cmd: string, _args: readonly string[] = [], options?: { env?: NodeJS.ProcessEnv }) => ({
      status: options?.env?.XDG_RUNTIME_DIR && options?.env?.DBUS_SESSION_BUS_ADDRESS ? 0 : 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(options?.env?.XDG_RUNTIME_DIR ? '' : 'Failed to connect to bus: No medium found'),
    }));

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'daemon-reload'],
      },
    ], { failureMode: 'strict' })).not.toThrow();

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'daemon-reload'],
      expect.objectContaining({
        env: expect.objectContaining({
          XDG_RUNTIME_DIR: `/run/user/${typeof process.getuid === 'function' ? process.getuid() : ''}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${typeof process.getuid === 'function' ? process.getuid() : ''}/bus`,
        }),
      }),
    );
  });

  it.each(['linux', 'darwin', 'win32'] as const)('lets the %s service manager finish installation without a competing command cutoff', async (platform) => {
    const { runDaemonServiceCommands } = await import('./apply');
    const { planDaemonServiceInstall } = await import('./plan');
    process.env.HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS = '30000';
    // The process boundary models #90: the native restart succeeds after 34 seconds.
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[], options?: { timeout?: number }) => {
      const startsService = args.includes('restart') || args.includes('bootstrap') || args.includes('/Run');
      return startsService && options?.timeout !== undefined && options.timeout < 34_000
        ? { status: null, error: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }) }
        : { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    });
    const plan = planDaemonServiceInstall({
      platform, channel: 'stable', targetMode: 'pinned', instanceId: 'company', activeServerId: 'company',
      uid: 501, userHomeDir: '/test', happierHomeDir: '/test/.happier',
      serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test', publicServerUrl: 'https://company.example.test',
      nodePath: '/npm/happier', entryPath: '',
    });
    expect(() => runDaemonServiceCommands(plan.commands, { failureMode: 'strict' })).not.toThrow();
  });

  it.each(['restart', 'uninstall'] as const)('allows systemd %s beyond the standalone cutoff within its containing deadline', async (action) => {
    const { runDaemonServiceCommands, applyDaemonServiceUninstallPlan } = await import('./apply');
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    let restarted = false;
    // The OS boundary models the kept Hetzner guest's 48-second stop phase.
    spawnSyncMock.mockImplementation((_command: string, _args: readonly string[], options?: { timeout?: number }) => {
      restarted = (options?.timeout ?? 0) >= 48_000;
      return restarted
        ? { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
        : { status: null, error: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }) };
    });

    const commands = [{ cmd: 'systemctl', args: ['--user', action === 'restart' ? 'restart' : 'stop', 'happier-daemon.default.service'] }];
    const execute = async () => {
      if (action === 'uninstall') {
        await applyDaemonServiceUninstallPlan({ platform: 'linux', commands, filesToRemove: [] }, { deadlineMs: 121_000 });
      } else {
        runDaemonServiceCommands(commands, { failureMode: 'strict', deadlineMs: 121_000 });
      }
    };
    await expect(execute()).resolves.toBeUndefined();
    expect(restarted).toBe(true);
  });

  it('refreshes the plist mtime before launchctl bootstrap in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    const dir = mkdtempSync(join(tmpdir(), 'happier-daemon-service-apply-'));
    const plistPath = join(dir, 'com.happier.cli.daemon.default.plist');
    writeFileSync(plistPath, '<plist version="1.0"></plist>', 'utf-8');
    const initialMtimeMs = statSync(plistPath).mtimeMs;

    spawnSyncMock.mockImplementation((_command: string, args: readonly string[] = []) => {
      if (args[0] === 'bootstrap') {
        const refreshedMtimeMs = statSync(plistPath).mtimeMs;
        return refreshedMtimeMs > initialMtimeMs
          ? { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
          : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Bootstrap failed: 5: Input/output error') };
      }
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootstrap', 'gui/501', plistPath],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('reports a failed bootstrap even when the preceding job is still visible during teardown', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockImplementation((_command: string, args: readonly string[] = []) => {
      if (args[0] === 'bootstrap') {
        return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Bootstrap failed: 5: Input/output error') };
      }
      if (args[0] === 'print' && args[1] === 'gui/501/com.happier.cli.daemon.default') {
        return { status: 0, stdout: Buffer.from('state = running'), stderr: Buffer.from('') };
      }
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootstrap', 'gui/501', '/tmp/com.happier.cli.daemon.default.plist'],
      },
    ], { failureMode: 'strict' })).toThrow(/Background service command failed: launchctl bootstrap/);
  });

  it('recovers GUI readiness and bootstrap within the containing service deadline, without repeating bootout', async () => {
    const { runDaemonServiceCommands } = await import('./apply');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let attempts = 0;
    const actions: string[] = [];
    spawnSyncMock.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'sleep') {
        now += Number(args[0]) * 1000;
        return { status: 0 };
      }
      actions.push(args[0]);
      if (args[0] === 'bootstrap' && ++attempts < 6) {
        return { status: 1, stderr: Buffer.from(attempts < 3
          ? 'Bootstrap failed: 125: Domain does not support specified action'
          : 'Bootstrap failed: 5: Input/output error') };
      }
      if (args[0] === 'print') return { status: 113, stderr: Buffer.from('Could not find service') };
      return { status: 0 };
    });
    expect(() => runDaemonServiceCommands([
      { cmd: 'launchctl', args: ['bootout', 'gui/501/com.happier.cli.daemon.default'], ignoreFailure: true },
      { cmd: 'launchctl', args: ['enable', 'gui/501/com.happier.cli.daemon.default'], ignoreFailure: true },
      { cmd: 'launchctl', args: ['bootstrap', 'gui/501', '/tmp/com.happier.cli.daemon.default.plist'] },
      { cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.happier.cli.daemon.default'] },
    ], { failureMode: 'strict', deadlineMs: 5000 })).not.toThrow();
    expect(attempts).toBe(6);
    expect(actions.filter(action => action === 'bootout')).toHaveLength(1);
    expect(actions.at(-1)).toBe('kickstart');
    expect(now).toBeLessThan(5000);
  });

  it.each([
    ['bootstrap', 'Bootstrap failed: 5: Input/output error', 'launchctl_io_error'],
    ['bootstrap', 'Bootstrap failed: 125: Domain does not support specified action', 'launchctl_domain_unsupported'],
    ['kickstart', 'Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501', 'launchctl_service_missing'],
  ])('settles persistent %s failure at the containing deadline with a closed reason', async (action, stderr, reason) => {
    const { runDaemonServiceCommands } = await import('./apply');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const timeouts: number[] = [];
    const remainingBudgets: number[] = [];
    spawnSyncMock.mockImplementation((command: string, args: readonly string[] = [], options?: { timeout?: number }) => {
      if (command === 'sleep') { now += Number(args[0]) * 1000; return { status: 0 }; }
      timeouts.push(options?.timeout ?? 0);
      remainingBudgets.push(1800 - now);
      return { status: 1, stderr: Buffer.from(stderr) };
    });
    try {
      runDaemonServiceCommands([{ cmd: 'launchctl', args: action === 'bootstrap'
        ? [action, 'gui/501', '/tmp/com.happier.cli.daemon.default.plist']
        : [action, '-k', 'gui/501/com.happier.cli.daemon.default'] }], { failureMode: 'strict', deadlineMs: 1800 });
      expect.fail('Expected deadline failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'service_start_timeout', serviceStep: action, serviceStepStatus: 'deadline_elapsed', reason });
    }
    expect(now).toBe(1800);
    expect(timeouts.length).toBeGreaterThan(1);
    expect(timeouts.every((timeout, index) => timeout > 0 && timeout <= remainingBudgets[index]!)).toBe(true);
  });

  it('does not retry a permanent launchctl error or grant an expired deadline another command', async () => {
    const { runDaemonServiceCommands } = await import('./apply');
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const commandsRun: string[] = [];
    spawnSyncMock.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'sleep') { now += Number(args[0]) * 1000; return { status: 0 }; }
      commandsRun.push(command);
      return { status: 1, stderr: Buffer.from('Bootstrap failed: 13: Permission denied') };
    });
    const commands = [{ cmd: 'launchctl', args: ['bootstrap', 'gui/501', '/tmp/com.happier.cli.daemon.default.plist'] }];
    expect(() => runDaemonServiceCommands(commands, { failureMode: 'strict', deadlineMs: 2000 })).toThrow(/Permission denied/);
    expect(commandsRun).toEqual(['launchctl']);
    spawnSyncMock.mockClear();
    expect(() => runDaemonServiceCommands(commands, { failureMode: 'strict', deadlineMs: 100 })).toThrow();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['launchctl', ['bootout', 'gui/501/private-label'], 'cleanup_bootout'],
    ['launchctl', ['bootstrap', 'gui/501', '/private/service.plist'], 'bootstrap'],
    ['launchctl', ['kickstart', '-k', 'gui/501/private-label'], 'kickstart'],
    ['systemctl', ['--user', 'start', 'private.service'], 'command'],
  ] as const)('classifies strict %s failures without copying command content into facts', async (cmd, args, serviceStep) => {
    const { runDaemonServiceCommands } = await import('./apply');
    spawnSyncMock.mockReturnValue({ status: 1, stderr: Buffer.from('private-output-secret') });
    expect(() => runDaemonServiceCommands([{ cmd, args }], { failureMode: 'strict' })).toThrowError(expect.objectContaining({
      code: 'service_command_failed', serviceStep, serviceStepStatus: 'failed',
      command: { program: cmd, action: cmd === 'systemctl' ? 'start' : args[0] },
      process: { exitStatus: 1 },
    }));
  });

  it('retains native timeout and signal facts without copying command arguments or output', async () => {
    const { runDaemonServiceCommands } = await import('./apply');
    spawnSyncMock.mockReturnValue({ status: null, signal: 'SIGTERM',
      error: Object.assign(new Error('private-error-message'), { code: 'ETIMEDOUT' }),
      stderr: Buffer.from('private-output-secret') });
    expect(() => runDaemonServiceCommands([
      { cmd: 'systemctl', args: ['--user', 'restart', 'private-unit.service'] },
    ], { failureMode: 'strict' })).toThrowError(expect.objectContaining({
      code: 'service_command_failed',
      command: { program: 'systemctl', action: 'restart' },
      process: { exitStatus: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' },
    }));
  });
});
