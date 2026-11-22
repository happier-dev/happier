import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const { processQueryMock, spawnSyncMock } = vi.hoisted(() => ({
  processQueryMock: vi.fn(),
  spawnSyncMock: vi.fn(() => { throw new Error('Unexpected process mutation'); }),
}));

// Keep command parsing, update admission and process classification real. Replace only OS
// commands and release-network I/O, so a failing test cannot stop this host or install a payload.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(() => { throw new Error('Unexpected synchronous process query'); }),
  execFile: (
    _command: string,
    _args: readonly string[],
    _options: ExecFileOptions,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    queueMicrotask(() => {
      try {
        callback(null, processQueryMock());
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), '');
      }
    });
  },
  spawnSync: vi.fn(() => ({ status: 0, stdout: '[]', stderr: '' })),
}));
vi.mock('cross-spawn', () => ({ default: { sync: spawnSyncMock } }));

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
    processQueryMock.mockReset();
    spawnSyncMock.mockClear();
    // Normal CLI initialization creates log/server directories before command dispatch.
    await import('./self');
    initialHomeEntries = readdirSync(homeDir);
  });

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
    processQueryMock.mockReturnValue(JSON.stringify([
      { ProcessId: process.ppid, ParentProcessId: 93101, Name: 'powershell.exe', CommandLine: 'powershell.exe' },
      { ProcessId: 93101, ParentProcessId: 93102, Name: 'claude.exe', CommandLine: 'claude.exe' },
      { ProcessId: 93102, ParentProcessId: 0, Name: 'hdev.exe', CommandLine: 'C:\\happier\\hdev.exe claude "--started-by" "daemon"' },
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
    expect(processQueryMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(readdirSync(homeDir)).toEqual(initialHomeEntries);
  });

  it('allows an independent terminal even while another Happier daemon is running', async () => {
    processQueryMock.mockReturnValue(JSON.stringify([
      { ProcessId: process.ppid, ParentProcessId: 0, Name: 'powershell.exe', CommandLine: 'powershell.exe' },
      { ProcessId: 93102, ParentProcessId: 0, Name: 'happier.exe', CommandLine: 'happier.exe daemon start-sync' },
    ]));
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('../runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).resolves.toBeUndefined();
  });

  it('allows fresh-install and independent-update ancestry through system processes without command lines', async () => {
    processQueryMock.mockReturnValue(JSON.stringify([
      { ProcessId: process.ppid, ParentProcessId: 93101, Name: 'pwsh.exe', CommandLine: 'pwsh.exe -File install-dev.ps1' },
      { ProcessId: 93101, ParentProcessId: 93102, Name: 'Runner.Listener.exe', CommandLine: null },
      { ProcessId: 93102, ParentProcessId: 0, Name: 'services.exe', CommandLine: null },
    ]));
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('../runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).resolves.toBeUndefined();
  });

  it('continues past a non-Happier ancestor without a command line to refuse a managed session', async () => {
    processQueryMock.mockReturnValue(JSON.stringify([
      { ProcessId: process.ppid, ParentProcessId: 93102, Name: 'cmd.exe', CommandLine: null },
      { ProcessId: 93102, ParentProcessId: 0, Name: 'hdev.exe', CommandLine: 'hdev.exe claude --started-by daemon' },
    ]));
    await expect(run(['update'])).rejects.toThrow('exit 1');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('Cannot update Happier from inside');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('refuses an unreadable potential Happier host and identifies the missing evidence without command text', async () => {
    processQueryMock.mockReturnValue(JSON.stringify([
      { ProcessId: process.ppid, ParentProcessId: 0, Name: 'node.exe', CommandLine: null },
    ]));
    await expect(run(['update'])).rejects.toThrow('exit 1');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain(`Cannot inspect Windows ancestor PID ${process.ppid}`);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'incomplete'])('refuses when process ancestry is %s', async (kind) => {
    if (kind === 'unavailable') {
      processQueryMock.mockImplementation(() => { throw new Error('CIM unavailable'); });
    } else {
      processQueryMock.mockReturnValue(JSON.stringify({ ProcessId: process.ppid, Name: 'powershell.exe' }));
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
    expect(processQueryMock).not.toHaveBeenCalled();
  });
});
