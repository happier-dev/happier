import { describe, expect, it, vi } from 'vitest';

import {
  compareProcessGenerationIdentities,
  processGenerationMatches,
  processGenerationProvesReuse,
  readProcessIdentityByPid,
} from './processIdentity';

describe('process generation identity', () => {
  it('uses process start time as generation identity independently of command drift', () => {
    expect(processGenerationMatches(1_000, 1_000)).toBe(true);
    expect(processGenerationProvesReuse(1_000, 2_000)).toBe(true);
    expect(processGenerationProvesReuse(undefined, 2_000)).toBe(false);
    expect(processGenerationProvesReuse(1_000, undefined)).toBe(false);
  });
});

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
      // `readProcessIdentityByPid` spreads the raw Windows CIM row, which still carries an
      // executable path of its own; only the local-services `LocalServiceProcessFact` field
      // (which had no reader) was removed.
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
          if (path === '/proc/777/cwd') return '/repo';
          throw new Error(`missing ${path}`);
        },
      },
    })).resolves.toEqual({
      pid: 777,
      ppid: 1,
      processStartTimeMs: 1_717_171_000_190,
      command: 'provider serve --port=43111',
      cwd: '/repo',
    });
  });
});

describe('compareProcessGenerationIdentities', () => {
  it('fences an equal whole-second pair on Darwin but decides it exactly on sub-second platforms', () => {
    expect(compareProcessGenerationIdentities('41:1754041400000', '41:1754041400000', 'darwin'))
      .toBe('ambiguous');
    expect(compareProcessGenerationIdentities('41:1754041400000', '41:1754041400000', 'linux'))
      .toBe('same');
  });

  it('proves reuse when a legacy record observes a different birth second', () => {
    expect(compareProcessGenerationIdentities(
      '41:1754041400000',
      '41:1754041401000',
      'darwin',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities('41:1000', '41:2000', 'linux')).toBe('reused');
  });

  it('fails closed on unparsable or pid-mismatched identities', () => {
    expect(compareProcessGenerationIdentities('garbage', '41:1000')).toBe('ambiguous');
    expect(compareProcessGenerationIdentities('41:1000', '42:1000'))
      .toBe('ambiguous');
    expect(compareProcessGenerationIdentities('41:1000', '')).toBe('ambiguous');
    expect(compareProcessGenerationIdentities('garbage', 'garbage')).toBe('ambiguous');
    expect(compareProcessGenerationIdentities(
      '9007199254740992:1000',
      '9007199254740992:1000',
      'linux',
    )).toBe('ambiguous');
  });

  it('decides tagged Darwin native identities exactly, including same-second reuse', () => {
    const sameGeneration = 'darwin-proc:41:1754041400:123456';
    expect(compareProcessGenerationIdentities(sameGeneration, sameGeneration, 'darwin'))
      .toBe('same');
    // The whole-second witness can never decide this case; the subsecond
    // witness must.
    expect(compareProcessGenerationIdentities(
      'darwin-proc:41:1754041400:123456',
      'darwin-proc:41:1754041400:654321',
      'darwin',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities(
      'darwin-proc:41:1754041400:123456',
      'darwin-proc:41:1754041401:000001',
      'darwin',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities(
      'darwin-proc:41:1754041400:123456',
      'darwin-proc:42:1754041400:123456',
      'darwin',
    )).toBe('ambiguous');
  });

  it('fences a tagged record against a legacy record and decides tagged job custody', () => {
    expect(compareProcessGenerationIdentities(
      '41:1754041400000',
      'darwin-proc:41:1754041400:123456',
      'darwin',
    )).toBe('ambiguous');
    expect(compareProcessGenerationIdentities(
      'winjob:Local\\happier-svc09-a',
      'winjob:Local\\happier-svc09-a',
      'win32',
    )).toBe('same');
    expect(compareProcessGenerationIdentities(
      'winjob:Local\\happier-svc09-a',
      'winjob:Local\\happier-svc09-b',
      'win32',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities(
      'winjob:Local\\happier-svc09-a',
      '41:1754041400000',
      'win32',
    )).toBe('ambiguous');
  });

});
