import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, psListMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  psListMock: vi.fn(),
}));

// Process execution is the system boundary; parsing and the snapshot cache stay real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execFileMock,
}));
vi.mock('ps-list', () => ({ default: psListMock }));

type Completion = (error: Error | null, stdout: string, stderr: string) => void;
const command = '/Users/alice/项目 with spaces/.runner-snapshots/bee5314ededb46bd/index.mjs opencode --started-by daemon';
const rows = { metadata: '  28800 1 501 0.2 1.5 /Users/alice/项目 with spaces/node\n', commands: `  28800 ${command}\n` };

describe('process snapshot locale isolation', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    psListMock.mockReset();
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it.each([undefined, 'fr_FR.ISO8859-1'])('preserves the daemon and concurrently launched child locale (%s) while scanning Unicode commands', async (ambientLocale) => {
    vi.stubEnv('LANG', ambientLocale);
    vi.stubEnv('LC_ALL', ambientLocale);
    const completions: Array<() => void> = [];
    let finishLegacyScan: (() => void) | undefined;
    psListMock.mockImplementation(() => new Promise<[]>(resolve => {
      finishLegacyScan = () => resolve([]);
    }));
    execFileMock.mockImplementation((_file: string, args: readonly string[], _options: unknown, callback: Completion) => {
      completions.push(() => callback(null, args.join(' ').includes('comm=') ? rows.metadata : rows.commands, ''));
      return { pid: 90000 + completions.length };
    });
    const { listProcessSnapshot } = await import('./processSnapshotCache');
    const pending = listProcessSnapshot({ ttlMs: 0 });
    await Promise.resolve();
    try {
      const inherited = JSON.parse(execFileSync(process.execPath, ['-e',
        'process.stdout.write(JSON.stringify({LANG: process.env.LANG, LC_ALL: process.env.LC_ALL}))',
      ], { encoding: 'utf8' }));
      expect(inherited).toEqual(ambientLocale === undefined ? {} : { LANG: ambientLocale, LC_ALL: ambientLocale });
      expect(execFileMock.mock.calls.length).toBeGreaterThan(0);
      for (const [file, , options] of execFileMock.mock.calls) {
        expect(file).toBe('ps');
        expect(options.env).toMatchObject({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PATH: process.env.PATH });
      }
    } finally {
      finishLegacyScan?.();
      for (const finish of completions) finish();
      await pending;
    }
    await expect(pending).resolves.toEqual([{ pid: 28800, ppid: 1, uid: 501, cpu: 0.2, memory: 1.5, name: 'node', cmd: command }]);
    expect(process.env.LANG).toBe(ambientLocale);
    expect(process.env.LC_ALL).toBe(ambientLocale);
  });

  it('rejects a failed scan without changing locale and allows the next scan to recover', async () => {
    vi.stubEnv('LANG', 'C');
    vi.stubEnv('LC_ALL', 'C');
    const failure = new Error('ps unavailable');
    execFileMock.mockImplementation((_file: string, _args: readonly string[], _options: unknown, callback: Completion) => {
      callback(failure, '', '');
      return { pid: 90001 };
    });
    const { listProcessSnapshot } = await import('./processSnapshotCache');
    await expect(listProcessSnapshot({ ttlMs: 0 })).rejects.toBe(failure);
    expect(process.env.LANG).toBe('C');
    expect(process.env.LC_ALL).toBe('C');
    execFileMock.mockImplementation((_file: string, args: readonly string[], _options: unknown, callback: Completion) => {
      callback(null, args.join(' ').includes('comm=') ? rows.metadata : rows.commands, '');
      return { pid: 90001 };
    });
    await expect(listProcessSnapshot({ ttlMs: 0 })).resolves.toMatchObject([{ pid: 28800, cmd: command }]);
  });

  it('omits exited processes and the scanner without losing Unicode executable names', async () => {
    execFileMock.mockImplementation((_file: string, args: readonly string[], _options: unknown, callback: Completion) => {
      callback(null, args.join(' ').includes('comm=')
        ? '28800 1 501 0.2 1.5 /Users/alice/项目/程 序\n28801 1 501 0.0 0.0 /bin/gone\n90001 1 501 0.0 0.0 /bin/ps\n'
        : `28800 ${command}\n28802 /bin/new\n90001 /bin/ps\n`, '');
      return { pid: 90001 };
    });
    const { listProcessSnapshot } = await import('./processSnapshotCache');
    await expect(listProcessSnapshot({ ttlMs: 0 })).resolves.toEqual([
      { pid: 28800, ppid: 1, uid: 501, cpu: 0.2, memory: 1.5, name: '程 序', cmd: command },
    ]);
  });

  it('accepts an empty scan and rejects malformed output', async () => {
    execFileMock.mockImplementation((_file: string, _args: readonly string[], _options: unknown, callback: Completion) => {
      callback(null, '\n', '');
      return { pid: 90001 };
    });
    const { listProcessSnapshot } = await import('./processSnapshotCache');
    await expect(listProcessSnapshot({ ttlMs: 0 })).resolves.toEqual([]);
    execFileMock.mockImplementation((_file: string, args: readonly string[], _options: unknown, callback: Completion) => {
      callback(null, args.join(' ').includes('comm=') ? 'invalid process row\n' : rows.commands, '');
      return { pid: 90001 };
    });
    await expect(listProcessSnapshot({ ttlMs: 0 })).rejects.toBeInstanceOf(Error);
  });

  it.each(['linux', 'win32'] as const)('retains ps-list discovery on %s without changing the locale', async platform => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    vi.stubEnv('LC_ALL', 'C');
    const processes = [{ pid: 1, ppid: 0, name: 'init' }];
    psListMock.mockImplementation(async () => {
      expect(process.env.LC_ALL).toBe('C');
      return processes;
    });
    const { listProcessSnapshot } = await import('./processSnapshotCache');
    await expect(listProcessSnapshot({ ttlMs: 0 })).resolves.toEqual(processes);
    expect(process.env.LC_ALL).toBe('C');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
