import { describe, expect, it, vi } from 'vitest';

import { readProcessIdentityByPid } from './processIdentity';

describe('readProcessIdentityByPid', () => {
  it('reads one exact Windows process identity through the bounded CIM command boundary', async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        ProcessId: 777,
        ParentProcessId: 12,
        CreationDate: '20250630123456.123000+000',
        CommandLine: '  provider.exe serve --hostname=127.0.0.1 --port=43111  ',
        ExecutablePath: 'C:\\Tools\\provider.exe',
      }),
    }));

    await expect(readProcessIdentityByPid(777, {
      platform: 'win32',
      execFile,
    })).resolves.toEqual({
      pid: 777,
      ppid: 12,
      processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56, 123),
      command: 'provider.exe serve --hostname=127.0.0.1 --port=43111',
      executablePath: 'C:\\Tools\\provider.exe',
    });
    expect(execFile).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining('Get-CimInstance Win32_Process -Filter "ProcessId = 777"'),
      ],
      {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    );
  });

  it.each([
    ['access denied', Object.assign(new Error('Access is denied'), { code: 'EACCES' })],
    ['timeout', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })],
    ['cancellation', Object.assign(new Error('aborted'), { name: 'AbortError' })],
  ])('fails closed when Windows process identity lookup reports %s', async (_label, error) => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32',
      execFile: async () => {
        throw error;
      },
    })).resolves.toBeNull();
  });

  it('fails closed when the requested PID is not present in otherwise valid CIM evidence', async () => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32',
      execFile: async () => ({
        stdout: JSON.stringify({
          ProcessId: 778,
          CreationDate: '20250630123456.123000+000',
          CommandLine: 'unrelated.exe',
        }),
      }),
    })).resolves.toBeNull();
  });

  it.each([
    [
      'start time is unavailable',
      {
        ProcessId: 777,
        CommandLine: 'provider.exe serve',
        ExecutablePath: 'C:\\Tools\\provider.exe',
      },
    ],
    [
      'command and executable path are unavailable',
      {
        ProcessId: 777,
        CreationDate: '20250630123456.123000+000',
      },
    ],
  ])('fails closed when exact Windows %s', async (_label, row) => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32',
      execFile: async () => ({ stdout: JSON.stringify(row) }),
    })).resolves.toBeNull();
  });

  it('preserves Linux procfs command and start-time identity', async () => {
    const files = new Map<string, string>([
      ['/proc/stat', 'cpu  1 2 3\nbtime 1717171000\n'],
      ['/proc/777/stat', '777 (provider) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 12345 22'],
      ['/proc/777/cmdline', 'provider\u0000serve\u0000--port=43111\u0000'],
    ]);

    await expect(readProcessIdentityByPid(777, {
      platform: 'linux',
      linuxBoundary: {
        readFile: async (path) => {
          const value = files.get(path);
          if (value === undefined) throw new Error(`missing ${path}`);
          return value;
        },
        readdir: async () => [],
        readlink: async (path) => {
          if (path === '/proc/777/exe') return '/usr/bin/provider';
          if (path === '/proc/777/cwd') return '/repo';
          throw new Error(`missing ${path}`);
        },
      },
    })).resolves.toEqual({
      pid: 777,
      ppid: 1,
      processStartTimeMs: 1_717_171_000_190,
      command: 'provider serve --port=43111',
      executablePath: '/usr/bin/provider',
      cwd: '/repo',
    });
  });
});
