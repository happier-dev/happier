import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';

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

  it('pins native tools and isolates PowerShell modules through the asynchronous boundary', async () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\System32');
    vi.stubEnv('PSModulePath', 'C:\\Program Files\\PowerShell\\7\\Modules');
    vi.stubEnv('psmodulepath', 'C:\\incompatible-modules');
    const parentEnvironment = { ...process.env };
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
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
    for (const [, , options] of childProcessMocks.execFile.mock.calls.slice(2)) {
      expect(options.env).toMatchObject({
        SystemRoot: 'C:\\WINDOWS',
        PATH: process.env.PATH,
        PSModulePath: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\Modules',
      });
      expect(Object.keys(options.env).filter((key) => key.toLowerCase() === 'psmodulepath')).toEqual(['PSModulePath']);
    }
    expect({ ...process.env }).toEqual(parentEnvironment);
  });

  it('pins native tools and isolates PowerShell modules through the synchronous boundary', () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\System32');
    vi.stubEnv('PSModulePath', 'C:\\Program Files\\PowerShell\\7\\Modules');
    vi.stubEnv('psmodulepath', 'C:\\incompatible-modules');
    const parentEnvironment = { ...process.env };
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
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
    for (const [, , options] of childProcessMocks.spawnSync.mock.calls.slice(2)) {
      expect(options.env).toMatchObject({
        SystemRoot: 'C:\\WINDOWS',
        PATH: process.env.PATH,
        PSModulePath: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\Modules',
      });
      expect(Object.keys(options.env).filter((key) => key.toLowerCase() === 'psmodulepath')).toEqual(['PSModulePath']);
    }
    expect({ ...process.env }).toEqual(parentEnvironment);
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
      'powershell.exe',
      'powershell.exe',
    ]);
    expect(runCommand.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['/setowner', '*S-1-5-21-123']));
    const applyCommand = runCommand.mock.calls[2]?.[1] ?? [];
    expect(applyCommand[3]).toContain('SetSecurityDescriptorSddlForm');
    expect(applyCommand).toEqual(expect.arrayContaining(['S-1-5-21-123', 'S-1-5-18', 'file']));
  });

  it('replaces unrelated explicit grants when applying a protected directory ACL', async () => {
    const expectedRules = [
      { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
      { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
    ];
    let rules = [...expectedRules, { sid: 'S-1-5-32-545', type: 'Allow', inherited: false, rights: 'Read' }];
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === 'whoami.exe') return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      if (command === 'icacls.exe') return { exitCode: 0, stdout: 'processed', stderr: '' };
      if (args[3]?.includes('SetSecurityDescriptorSddlForm')) {
        expect(args[3]).toContain('Set-Acl');
        expect(args).toContain('directory');
        rules = expectedRules;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ownerSid: 'S-1-5-21-123', protected: true, reparsePoint: false, rules }),
        stderr: '',
      };
    });

    await createWindowsProtectedAclBoundary({ runCommand }).applyAndVerify({
      path: 'C:\\Users\\user\\private',
      kind: 'directory',
    });
    expect(rules).toEqual(expectedRules);
  });

  it('replaces unrelated explicit grants through the synchronous boundary too', () => {
    const expectedRules = [
      { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
      { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
    ];
    let rules = [...expectedRules, { sid: 'S-1-5-32-545', type: 'Allow', inherited: false, rights: 'Read' }];
    const runCommand = vi.fn<WindowsProtectedAclCommandRunnerSync>((command, args) => {
      if (command === 'whoami.exe') return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      if (command === 'icacls.exe') return { exitCode: 0, stdout: 'processed', stderr: '' };
      if (args[3]?.includes('SetSecurityDescriptorSddlForm')) {
        expect(args[3]).toContain('Set-Acl');
        expect(args).toContain('file');
        rules = expectedRules;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ownerSid: 'S-1-5-21-123', protected: true, reparsePoint: false, rules }),
        stderr: '',
      };
    });

    createWindowsProtectedAclBoundarySync({ runCommand }).applyAndVerify({
      path: 'C:\\Users\\user\\private.json',
      kind: 'file',
    });
    expect(rules).toEqual(expectedRules);
  });

  it('identifies the rejected path and access rules when verification cannot prove the DACL', () => {
    const path = 'C:\\Users\\user\\private.json';
    const extraRule = { sid: 'S-1-5-32-545', type: 'Allow', inherited: false, rights: 'Read' };
    const boundary = createWindowsProtectedAclBoundarySync({
      runCommand(command) {
        if (command === 'whoami.exe') return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ownerSid: 'S-1-5-21-123',
            protected: true,
            reparsePoint: false,
            rules: [
              { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
              { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
              extraRule,
            ],
          }),
          stderr: '',
        };
      },
    });

    let message = '';
    try {
      boundary.verify({ path, kind: 'file' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(JSON.stringify(path));
    expect(message).toContain(JSON.stringify(extraRule));
  });

  it.runIf(process.platform === 'win32').each(['async', 'sync'] as const)('isolates incompatible modules and enforces real ACLs through the %s boundary', async mode => {
    const { execFile, spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    childProcessMocks.execFile.mockImplementation(execFile);
    childProcessMocks.spawnSync.mockImplementation(spawnSync);
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error('Windows system root is unavailable');
    const root = await mkdtemp(join(tmpdir(), 'happier-acl-'));
    const boundary = mode === 'async' ? createWindowsProtectedAclBoundary() : createWindowsProtectedAclBoundarySync();
    const verify = async (path = root) => await boundary.verify({ path, kind: 'directory' });
    try {
      // Synthetic distribution module: Windows PowerShell must not load the
      // incompatible Security module advertised by its caller's search path.
      const moduleRoot = join(root, 'foreign-modules');
      const securityModule = join(moduleRoot, 'Microsoft.PowerShell.Security');
      await mkdir(securityModule, { recursive: true });
      await writeFile(join(securityModule, 'Microsoft.PowerShell.Security.psd1'),
        "@{ ModuleVersion = '99.0'; PowerShellVersion = '7.0'; RootModule = 'Security.psm1'; FunctionsToExport = @('Get-Acl', 'Set-Acl') }");
      await writeFile(join(securityModule, 'Security.psm1'), 'throw "Incompatible synthetic distribution module"');
      vi.stubEnv('PSModulePath', moduleRoot);
      await boundary.applyAndVerify({ path: root, kind: 'directory' });
      await promisify(execFile)(win32.join(systemRoot, 'System32', 'icacls.exe'), [
        root, '/grant', '*S-1-5-32-545:R',
      ]);
      await expect(verify()).rejects.toThrow(/ACL entries/u);
      await boundary.applyAndVerify({ path: root, kind: 'directory' });
      await expect(verify()).resolves.toBeUndefined();
      await expect(verify(join(root, 'missing'))).rejects.toThrow(/powershell\.exe.*exit 1/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it.each(['async', 'sync'] as const)('preserves bounded diagnostics for a malformed %s inspection result', async mode => {
    const runCommand = (command: string) => command === 'whoami.exe'
      ? { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' }
      : { exitCode: 0, stdout: 'sensitive-invalid-output', stderr: `module import failed\r\n${'x'.repeat(600)}` };
    const boundary = mode === 'async'
      ? createWindowsProtectedAclBoundary({ runCommand: async (command) => runCommand(command) })
      : createWindowsProtectedAclBoundarySync({ runCommand });
    const error = await Promise.resolve().then(() => boundary.verify({ path: 'C:\\private.json', kind: 'file' }))
      .then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/invalid JSON.*module import failed/u);
    expect(message).toContain('…');
    expect(message).not.toContain('x'.repeat(513));
    expect(message).not.toContain('sensitive-invalid-output');
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
