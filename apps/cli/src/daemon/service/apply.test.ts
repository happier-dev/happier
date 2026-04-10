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

  it('ignores launchctl kickstart service-materialization races in strict mode', async () => {
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
});
