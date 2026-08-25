import { describe, expect, it, vi } from 'vitest';

import {
  parseWindowsProcessInventoryJson,
  readWindowsProcessInventory,
} from './windowsProcessInventory';

describe('Windows process inventory', () => {
  it('preserves complete privacy-sensitive command facts only at the raw in-memory owner', () => {
    const longArgument = `--model=${'x'.repeat(1_200)}`;
    const facts = parseWindowsProcessInventoryJson(JSON.stringify({
      ProcessId: 1234,
      Name: 'happier.exe',
      ParentProcessId: 100,
      CreationDate: '20250630123456.123000+000',
      CommandLine: `"C:\\Program Files\\Happier\\happier.exe" codex ${longArgument}`,
      ExecutablePath: 'C:\\Program Files\\Happier\\happier.exe',
    }));

    expect(facts.get(1234)).toEqual({
      pid: 1234,
      name: 'happier.exe',
      ppid: 100,
      processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56, 123),
      command: expect.stringContaining(longArgument),
      executablePath: 'C:\\Program Files\\Happier\\happier.exe',
    });
  });

  it('accepts the exact Windows PowerShell 5.1 CIM DateTime JSON representation', () => {
    const facts = parseWindowsProcessInventoryJson(JSON.stringify({
      ProcessId: 1234,
      CreationDate: '/Date(1785142016562)/',
      CommandLine: 'happier.exe codex',
      ExecutablePath: 'C:\\Happier\\happier.exe',
    }));

    expect(facts.get(1234)?.processStartTimeMs).toBe(1_785_142_016_562);
  });

  it('prefers the PowerShell-projected numeric process birth timestamp', () => {
    const facts = parseWindowsProcessInventoryJson(JSON.stringify({
      ProcessId: 1234,
      ProcessStartTimeMs: 1_785_142_016_563,
      CreationDate: '/Date(1785142016562)/',
      CommandLine: 'happier.exe codex',
      ExecutablePath: 'C:\\Happier\\happier.exe',
    }));

    expect(facts.get(1234)?.processStartTimeMs).toBe(1_785_142_016_563);
  });

  it('uses one bounded all-process CIM query without a PID filter', async () => {
    const execFile = vi.fn(async () => ({ stdout: '[]' }));

    await expect(readWindowsProcessInventory({ execFile }))
      .resolves.toEqual(new Map());

    expect(execFile).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/u),
      ['-NoProfile', '-NonInteractive', '-Command', expect.stringContaining(
        'Get-CimInstance Win32_Process |',
      )],
      {
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const calls = execFile.mock.calls as unknown as Array<
      [string, string[], { timeout: number; maxBuffer: number }]
    >;
    expect(calls[0]?.[1]?.[3]).not.toContain('-Filter');
    expect(calls[0]?.[2]?.timeout).toBeGreaterThan(2_000);
    expect(calls[0]?.[2]?.timeout).toBeLessThanOrEqual(5_000);
  });

  // Process identity is a custody fact. Reading it through whichever `powershell.exe` the ambient
  // `PATH` happens to expose lets availability, launch, inventory and termination each answer for
  // a different binary; the installed Windows PowerShell is the one every step must agree on.
  it('reads identity through the installed Windows PowerShell rather than an ambient one', async () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
    const execFile = vi.fn(async () => ({ stdout: '[]' }));

    await readWindowsProcessInventory({ execFile, pids: [777] });

    expect(execFile).toHaveBeenCalledWith(
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.any(Array),
      expect.any(Object),
    );
    vi.unstubAllEnvs();
  });

  it('uses the same parser and a narrower buffer for exact PID inventory', async () => {
    const execFile = vi.fn(async () => ({ stdout: '[]' }));

    await readWindowsProcessInventory({
      execFile,
      pids: [777, 777, -1],
    });

    const calls = execFile.mock.calls as unknown as Array<
      [string, string[], { timeout: number; maxBuffer: number }]
    >;
    expect(calls[0]?.[1]?.[3]).toContain(
      '-Filter "ProcessId = 777"',
    );
    expect(calls[0]?.[2]).toEqual({
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  });

  it('rejects unreadable JSON rather than treating it as an empty process list', async () => {
    await expect(readWindowsProcessInventory({
      execFile: async () => ({ stdout: 'not-json' }),
    })).rejects.toThrow('Windows process inventory was unreadable');
  });
});
