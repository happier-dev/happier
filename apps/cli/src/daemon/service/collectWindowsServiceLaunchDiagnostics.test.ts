import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import { collectWindowsServiceLaunchDiagnostics } from './collectWindowsServiceLaunchDiagnostics';

describe('collectWindowsServiceLaunchDiagnostics', () => {
  let homeDir = '';
  let originalPlatformDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-windows-diag-'));
    await mkdir(join(homeDir, 'logs'), { recursive: true });
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    spawnSyncMock.mockReset();
  });

  afterEach(async () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  function forceWindowsPlatform(): void {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      enumerable: true,
      value: 'win32',
    });
  }

  it('returns null when no log files exist (and not on win32, no schtasks)', () => {
    // On non-Windows the schtasks query short-circuits to null, and missing
    // log files contribute nothing, so the helper should produce no output
    // rather than a stub "no diagnostics found" string the caller would
    // have to special-case.
    const result = collectWindowsServiceLaunchDiagnostics({
      taskName: 'Happier\\happier-daemon.default',
      stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
      stderrPath: join(homeDir, 'logs', 'daemon-service.default.err.log'),
    });
    expect(result).toBeNull();
  });

  it('tails the stderr log with a clear header and indented body', async () => {
    // Mirror the actual on-Windows symptom: PowerShell's wrapper exits with
    // a NativeCommandError before stderr redirection completes, so the
    // wrapper writes the stack/trace to the redirected file. The diag must
    // surface those lines with an obvious "Wrapper stderr" caption so the
    // user knows where the message came from.
    const stderrPath = join(homeDir, 'logs', 'daemon-service.default.err.log');
    await writeFile(stderrPath, [
      'node:internal/modules/cjs/loader:1459',
      "Error: Cannot find module 'C:\\Users\\test_qa\\.happier\\cli\\current\\package-dist\\index.mjs'",
      "    at Module._resolveFilename (node:internal/modules/cjs/loader:1456:15)",
      "code: 'MODULE_NOT_FOUND'",
    ].join('\n'), 'utf8');

    const result = collectWindowsServiceLaunchDiagnostics({
      taskName: 'Happier\\happier-daemon.default',
      stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
      stderrPath,
    });

    expect(result).not.toBeNull();
    expect(result).toContain('Wrapper stderr');
    expect(result).toContain('MODULE_NOT_FOUND');
    expect(result).toContain('Cannot find module');
  });

  it('caps the stderr tail to the last 25 non-empty lines', async () => {
    const stderrPath = join(homeDir, 'logs', 'daemon-service.default.err.log');
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}`);
    await writeFile(stderrPath, lines.join('\n'), 'utf8');

    const result = collectWindowsServiceLaunchDiagnostics({
      taskName: 'Happier\\happier-daemon.default',
      stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
      stderrPath,
    });

    expect(result).not.toBeNull();
    expect(result).toContain('line-099');
    expect(result).toContain('line-075');
    expect(result).not.toContain('line-074');
  });

  it('tails the stdout log when stderr is empty so daemon-side errors still surface', async () => {
    // In practice the wrapper succeeds at launching the daemon, but the
    // daemon then loops on something like ECONNREFUSED to the relay. That
    // gets logged to the structured stdout log, not the wrapper stderr.
    // Verify the helper surfaces stdout independently.
    const stdoutPath = join(homeDir, 'logs', 'daemon-service.default.out.log');
    const stderrPath = join(homeDir, 'logs', 'daemon-service.default.err.log');
    await writeFile(stderrPath, '', 'utf8');
    await writeFile(stdoutPath, [
      '[DAEMON RUN] Machine registration unavailable; retrying',
      "  url: 'http://127.0.0.1:3005/v1/machines'",
      "  code: 'ECONNREFUSED'",
    ].join('\n'), 'utf8');

    const result = collectWindowsServiceLaunchDiagnostics({
      taskName: 'Happier\\happier-daemon.default',
      stdoutPath,
      stderrPath,
    });

    expect(result).not.toBeNull();
    expect(result).toContain('Wrapper stdout');
    expect(result).toContain('ECONNREFUSED');
  });

  it('uses invariant PowerShell scheduled-task JSON before falling back to localized schtasks text', () => {
    forceWindowsPlatform();
    spawnSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'powershell.exe') {
        return {
          status: 0,
          stdout: JSON.stringify({
            exists: true,
            enabled: true,
            active: false,
            stateLabel: 'Ready',
            stateValue: 3,
            lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
            lastTaskResult: 267009,
            taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test_qa\\.happier\\services\\happier-daemon.default.ps1',
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = collectWindowsServiceLaunchDiagnostics({
      taskName: 'Happier\\happier-daemon.default',
      stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
      stderrPath: join(homeDir, 'logs', 'daemon-service.default.err.log'),
    });

    expect(result).not.toBeNull();
    expect(result).toContain('Scheduled task Happier\\happier-daemon.default');
    expect(result).toContain('Last result:   267009');
    expect(result).toContain('powershell.exe -NoProfile');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-Command']),
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      'schtasks',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('decodes UTF-16 LE log files written by PowerShell `>>` redirects', async () => {
    // Real-world: PowerShell's append-redirect on Windows writes UTF-16 LE
    // with a BOM. Reading that as UTF-8 produces "every char is space-
    // separated" garbage. The collector must detect the BOM and decode as
    // UTF-16 so the diagnostic message stays readable to humans.
    const stderrPath = join(homeDir, 'logs', 'daemon-service.default.err.log');
    const text = "Error: Cannot find module 'happier.exe'\nMODULE_NOT_FOUND";
    const utf16Buffer = Buffer.concat([
      Buffer.from([0xFF, 0xFE]), // UTF-16 LE BOM
      Buffer.from(text, 'utf16le'),
    ]);
    await writeFile(stderrPath, utf16Buffer);

    const result = collectWindowsServiceLaunchDiagnostics({
      taskName: 'Happier\\happier-daemon.default',
      stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
      stderrPath,
    });

    expect(result).not.toBeNull();
    expect(result).toContain('MODULE_NOT_FOUND');
    expect(result).toContain('Cannot find module');
    // Verify we DON'T see the UTF-16-as-UTF-8 garbage signature: spaced-out
    // ASCII characters. If decoding was wrong, every character would be
    // followed by a space (because the high byte of LE UTF-16 ASCII is 0x00,
    // which UTF-8 renders as visible "space"-like).
    expect(result).not.toContain('M O D U L E');
  });

  it('skips the stdout section when the file is empty', async () => {
    const stdoutPath = join(homeDir, 'logs', 'daemon-service.default.out.log');
    const stderrPath = join(homeDir, 'logs', 'daemon-service.default.err.log');
    await writeFile(stdoutPath, '', 'utf8');
    await writeFile(stderrPath, 'real failure', 'utf8');

    const result = collectWindowsServiceLaunchDiagnostics({
      taskName: 'Happier\\happier-daemon.default',
      stdoutPath,
      stderrPath,
    });

    expect(result).not.toBeNull();
    expect(result).not.toContain('Wrapper stdout');
    expect(result).toContain('Wrapper stderr');
  });
});
