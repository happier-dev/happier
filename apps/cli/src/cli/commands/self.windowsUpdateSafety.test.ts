import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessCensusRow, ProcessCensusSnapshot } from '@/processes/census/processCensus';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const { nativeCensusMock, spawnSyncMock } = vi.hoisted(() => ({
  nativeCensusMock: vi.fn(),
  spawnSyncMock: vi.fn(() => { throw new Error('Unexpected process mutation'); }),
}));

// Keep command parsing, update admission and process classification real. Replace only OS
// commands and release-network I/O, so a failing test cannot stop this host or install a payload.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(() => '[]'),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '[]', stderr: '' })),
}));
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  execFileWithDeadline: nativeCensusMock,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
    String(path).endsWith('happier-process-custody.exe') || actual.existsSync(path) };
});
vi.mock('cross-spawn', () => ({ default: { sync: spawnSyncMock } }));

function census(
  rows: ReadonlyArray<Pick<ProcessCensusRow, 'pid' | 'ppid' | 'name' | 'commandLine'>>,
  partial?: Extract<ProcessCensusSnapshot, { status: 'ok' }>['partial'],
) {
  return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1, ...(partial ? { partial } : {}),
    rows: [{ pid: process.pid, ppid: process.ppid, name: 'happier.exe', commandLine: 'happier.exe self update' }, ...rows]
      .map(row => ({ ...row, start: { startTimeMs: 1 }, principal: { kind: 'sid', value: 'self' }, memory: null, cpuTimeUs: null })),
  }) };
}

describe('Windows self-update admission', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  const originalArgv = process.argv;
  let homeDir: string;
  let initialHomeEntries: string[];

  beforeEach(async () => {
    vi.resetModules();
    process.argv = ['happier', '/opt/happier/bin/happier'];
    homeDir = mkdtempSync(join(tmpdir(), 'happier-update-safety-'));
    envScope.patch({ HAPPIER_HOME_DIR: homeDir });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit 1'); }) as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    nativeCensusMock.mockReset();
    spawnSyncMock.mockClear();
    // Normal CLI initialization creates log/server directories before command dispatch.
    await import('./self');
    initialHomeEntries = readdirSync(homeDir);
  }, 60_000);

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process, 'platform', platform);
    envScope.restore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    const { handleSelfCliCommand } = await import('./self');
    await handleSelfCliCommand({ args: ['self', ...args], rawArgv: ['happier', 'self', ...args], terminalRuntime: null });
  }

  it.each([
    ['update'],
    ['__install-payload', '--component', 'happier-cli', '--payload-root', 'C:\\staged', '--version', '0.2.17'],
  ])('refuses %j from a shell below a daemon-started session before changing the install', async (...args) => {
    nativeCensusMock.mockResolvedValue(census([
      { pid: process.ppid, ppid: 93101, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 93101, ppid: 93102, name: 'claude.exe', commandLine: 'claude.exe' },
      { pid: 93102, ppid: 0, name: 'hdev.exe', commandLine: 'C:\\happier\\hdev.exe claude "--started-by" "daemon"' },
    ]));

    await expect(run(args)).rejects.toThrow('exit 1');
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(readdirSync(homeDir)).toEqual(initialHomeEntries);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('independent terminal');
  });

  it.each(['--help', '-h'])('prints update %s without entering the updater', async (flag) => {
    await run(['update', flag]);
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('Usage:');
    expect(nativeCensusMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(readdirSync(homeDir)).toEqual(initialHomeEntries);
  });

  it('allows an independent terminal even while another Happier daemon is running', async () => {
    nativeCensusMock.mockResolvedValue(census([
      { pid: process.ppid, ppid: 93199, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 93102, ppid: 0, name: 'happier.exe', commandLine: 'happier.exe daemon start-sync' },
    ]));
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('../runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).resolves.toBeUndefined();
  });

  it('refuses an unreadable ancestor reported by the native census instead of treating it as exited', async () => {
    nativeCensusMock.mockResolvedValue(census([
      { pid: process.ppid, ppid: 93101, name: 'powershell.exe', commandLine: 'powershell.exe' },
    ], [{ pid: 93101, missing: ['start', 'principal'] }]));
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('../runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).rejects.toThrow('Cannot verify Windows update process ancestry');
  });

  it.each(['unavailable', 'incomplete'])('refuses when process ancestry is %s', async (kind) => {
    if (kind === 'unavailable') {
      nativeCensusMock.mockImplementation(() => { throw new Error('Native census unavailable'); });
    } else {
      nativeCensusMock.mockResolvedValue(census([{ pid: process.ppid, ppid: null, name: 'powershell.exe' }]));
    }
    await expect(run(['update'])).rejects.toThrow('exit 1');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('Cannot verify Windows update process ancestry');
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(readdirSync(homeDir)).toEqual(initialHomeEntries);
  });

  it('leaves non-Windows update admission unchanged', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('../runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).resolves.toBeUndefined();
    expect(nativeCensusMock).not.toHaveBeenCalled();
  });
});
