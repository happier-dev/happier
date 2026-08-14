import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: childProcessMocks.execFile,
    spawnSync: childProcessMocks.spawnSync,
  };
});

import {
  createWindowsProtectedAclBoundary,
  createWindowsProtectedAclBoundarySync,
  type WindowsProtectedAclCommandRunnerSync,
} from './windowsProtectedAcl';

describe('Windows protected ACL boundary', () => {
  afterEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.spawnSync.mockReset();
    vi.unstubAllEnvs();
  });

  it('uses the same native System32 command map through the asynchronous boundary', async () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\System32');
    childProcessMocks.execFile.mockImplementation((...rawArgs) => {
      const [command, , , callback] = rawArgs as [
        string,
        readonly string[],
        unknown,
        (error: null, stdout: string, stderr: string) => void,
      ];
      const normalizedCommand = command.toLowerCase();
      if (normalizedCommand.endsWith('\\whoami.exe')) {
        callback(null, '"USER","S-1-5-21-123"', '');
      } else if (normalizedCommand.endsWith('\\icacls.exe')) {
        callback(null, 'processed', '');
      } else {
        callback(null, JSON.stringify({
          ownerSid: 'S-1-5-21-123',
          protected: true,
          reparsePoint: false,
          rules: [
            { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
            { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
          ],
        }), '');
      }
    });

    await createWindowsProtectedAclBoundary().applyAndVerify({
      path: 'C:\\Users\\user\\private.json',
      kind: 'file',
    });

    expect(childProcessMocks.execFile.mock.calls.map(([command]) => command)).toEqual([
      'C:\\WINDOWS\\System32\\whoami.exe',
      'C:\\WINDOWS\\System32\\icacls.exe',
      'C:\\WINDOWS\\System32\\icacls.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
  });

  it('uses native System32 ACL commands even when Git tools shadow whoami on PATH', () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\System32');
    childProcessMocks.spawnSync.mockImplementation((command) => {
      const normalizedCommand = String(command).toLowerCase();
      if (normalizedCommand.endsWith('\\whoami.exe')) {
        return { status: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      }
      if (normalizedCommand.endsWith('\\icacls.exe')) {
        return { status: 0, stdout: 'processed', stderr: '' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          ownerSid: 'S-1-5-21-123',
          protected: true,
          reparsePoint: false,
          rules: [
            { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
            { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
          ],
        }),
        stderr: '',
      };
    });

    createWindowsProtectedAclBoundarySync().applyAndVerify({
      path: 'C:\\Users\\user\\private.json',
      kind: 'file',
    });

    expect(childProcessMocks.spawnSync.mock.calls.map(([command]) => command)).toEqual([
      'C:\\WINDOWS\\System32\\whoami.exe',
      'C:\\WINDOWS\\System32\\icacls.exe',
      'C:\\WINDOWS\\System32\\icacls.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
  });

  it('fails explicitly when the Windows system root is unavailable', () => {
    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;
    try {
      expect(() => createWindowsProtectedAclBoundarySync().verify({
        path: 'C:\\Users\\user\\private.json',
        kind: 'file',
      })).toThrow(/SystemRoot.*WINDIR/u);
      expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousWindir;
    }
  });

  it('applies and verifies current-user and SYSTEM-only ACLs through one command owner', () => {
    const runCommand = vi.fn<WindowsProtectedAclCommandRunnerSync>((command) => {
      if (command === 'whoami.exe') {
        return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      }
      if (command === 'icacls.exe') {
        return { exitCode: 0, stdout: 'processed', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ownerSid: 'S-1-5-21-123',
          protected: true,
          reparsePoint: false,
          rules: [
            { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
            { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
          ],
        }),
        stderr: '',
      };
    });
    const boundary = createWindowsProtectedAclBoundarySync({ runCommand });

    boundary.applyAndVerify({ path: 'C:\\Users\\user\\private.json', kind: 'file' });

    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      'whoami.exe',
      'icacls.exe',
      'icacls.exe',
      'powershell.exe',
    ]);
    expect(runCommand.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['/setowner', '*S-1-5-21-123']));
    expect(runCommand.mock.calls[2]?.[1]).toEqual(expect.arrayContaining([
      '/inheritancelevel:r',
      '*S-1-5-21-123:F',
      '*S-1-5-18:F',
    ]));
  });

  it('fails closed when verification reports an inherited ACL', () => {
    const boundary = createWindowsProtectedAclBoundarySync({
      runCommand(command) {
        if (command === 'whoami.exe') {
          return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
        }
        if (command === 'icacls.exe') return { exitCode: 0, stdout: '', stderr: '' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ownerSid: 'S-1-5-21-123',
            protected: false,
            reparsePoint: false,
            rules: [],
          }),
          stderr: '',
        };
      },
    });

    expect(() => boundary.applyAndVerify({ path: 'C:\\unsafe.json', kind: 'file' })).toThrow(/inherits ACL/u);
  });

  it('reports command, exit code, and bounded stderr without exposing stdout', () => {
    const longStderr = `Access denied. ${'x'.repeat(600)}`;
    const boundary = createWindowsProtectedAclBoundarySync({
      runCommand() {
        return { exitCode: 7, stdout: 'sensitive-user-output', stderr: longStderr };
      },
    });

    let message = '';
    try {
      boundary.verify({ path: 'C:\\unsafe.json', kind: 'file' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/whoami\.exe.*exit 7.*Access denied\./u);
    expect(message).toContain('…');
    expect(message).not.toContain('x'.repeat(513));
    expect(message).not.toContain('sensitive-user-output');
  });
});
