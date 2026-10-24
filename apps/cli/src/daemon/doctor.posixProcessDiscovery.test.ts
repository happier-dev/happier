import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, psListMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  psListMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: execFileSyncMock,
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

describe('doctor POSIX process discovery', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    psListMock.mockReset();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('recognizes a managed runner when Darwin truncates comm in a multi-column ps projection', async () => {
    const pid = 28_799;
    const command = [
      '/Users/alice/.local/share/fnm/node-versions/v22.22.1/installation/bin/node',
      '--no-warnings',
      '--no-deprecation',
      '/repo/apps/cli/.runner-snapshots/bee5314ededb46bd/index.mjs',
      'opencode',
      '--happy-starting-mode',
      'remote',
      '--started-by',
      'daemon',
    ].join(' ');

    execFileSyncMock.mockImplementation((_file, args: readonly string[]) => {
      const projection = args.at(1);
      if (projection === 'stat=,comm=,command=') {
        return `Ss   /Users/alice/.l ${command}`;
      }
      if (projection === 'stat=,ucomm=,command=') {
        return `Ss   node ${command}`;
      }
      return '';
    });

    const { findHappyProcessByPid } = await import('./doctor');

    await expect(findHappyProcessByPid(pid)).resolves.toEqual({
      pid,
      command,
      type: 'daemon-spawned-session',
    });
  });

  it('forces a UTF-8 locale on every ps invocation so launchd-inherited C locales cannot M-escape command lines', async () => {
    const pid = 28_800;
    const command = '/Users/alice/项目/.runner-snapshots/bee5314ededb46bd/index.mjs opencode --started-by daemon';

    execFileSyncMock.mockImplementation((_file, args: readonly string[]) => {
      if (args.at(1) === 'stat=,ucomm=,command=') {
        return `Ss   node ${command}`;
      }
      if (args.at(0) === 'eww') {
        return `HAPPIER_HOME_DIR=/h ${command}`;
      }
      return '';
    });

    const { readProcessInfoByPid } = await import('./doctor');

    const info = await readProcessInfoByPid(pid);

    const psOptions = execFileSyncMock.mock.calls
      .filter(([file]) => file === 'ps')
      .map(([, , options]) => options as { env?: Record<string, string | undefined> });
    // readProcessInfoByPid on Darwin exercises both ps projections:
    // the stat/ucomm/command lookup and the `eww` environment-variable follow-up.
    expect(psOptions).toHaveLength(2);
    for (const options of psOptions) {
      expect(options.env?.LANG).toBe('en_US.UTF-8');
      expect(options.env?.LC_ALL).toBe('en_US.UTF-8');
      expect(options.env?.PATH).toBe(process.env.PATH);
    }
    expect(info?.cmd).toBe(command);
    expect(info?.daemonOwnershipEnvironmentVariables?.HAPPIER_HOME_DIR).toBe('/h');
  });
});
