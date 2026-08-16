import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWindowsProtectedLocalStateAclBoundary,
  createProtectedLocalStateFileExclusive,
  ensureProtectedLocalStateDirectory,
  readProtectedLocalStateFile,
  consumeProtectedLocalStateFile,
  removeProtectedLocalStateFile,
  writeProtectedLocalStateFileAtomic,
  type WindowsProtectedLocalStateCommandRunner,
} from './protectedLocalState';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-protected-state-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform !== 'win32')('protected local state on POSIX', () => {
  it('creates and verifies owner-only directories and exclusive regular files', async () => {
    const root = await createRoot();
    const directory = join(root, 'authority');
    const path = join(directory, 'state.json');

    await ensureProtectedLocalStateDirectory(directory);
    await createProtectedLocalStateFileExclusive(path, '{"v":1}');

    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readProtectedLocalStateFile(path)).toBe('{"v":1}');
    await expect(createProtectedLocalStateFileExclusive(path, 'duplicate')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects symlinks, permissive files, and wrong-owner expectations instead of hardening them silently', async () => {
    const root = await createRoot();
    const directory = join(root, 'authority');
    const target = join(directory, 'target');
    const link = join(directory, 'link');
    await ensureProtectedLocalStateDirectory(directory);
    await writeFile(target, 'secret', { mode: 0o600 });
    await symlink(target, link);

    await expect(readProtectedLocalStateFile(link)).rejects.toThrow(/symbolic link|no-follow/i);
    await chmod(target, 0o644);
    await expect(readProtectedLocalStateFile(target)).rejects.toThrow(/permissions/i);
    await chmod(target, 0o600);
    await expect(readProtectedLocalStateFile(target, {
      expectedUid: (process.getuid?.() ?? 0) + 1,
    })).rejects.toThrow(/owner/i);
  });

  it('atomically replaces durable state without leaving a permissive destination or temporary file', async () => {
    const root = await createRoot();
    const path = join(root, 'authority', 'state.json');

    await writeProtectedLocalStateFileAtomic(path, 'one');
    await writeProtectedLocalStateFileAtomic(path, 'two');

    expect(await readFile(path, 'utf8')).toBe('two');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect((await import('node:fs/promises')).readdir(join(root, 'authority'))).resolves.toEqual(['state.json']);
  });

  it('validates an existing file before atomic replacement or removal', async () => {
    const root = await createRoot();
    const directory = join(root, 'authority');
    const target = join(directory, 'target');
    const link = join(directory, 'state.json');
    await ensureProtectedLocalStateDirectory(directory);
    await writeFile(target, 'secret', { mode: 0o600 });
    await symlink(target, link);

    await expect(writeProtectedLocalStateFileAtomic(link, 'replacement')).rejects.toThrow(/symbolic link|no-follow/i);
    await expect(removeProtectedLocalStateFile(link)).rejects.toThrow(/symbolic link|no-follow/i);
    expect(await readFile(target, 'utf8')).toBe('secret');
  });

  it('consumes a protected one-time file and removes its directory entry durably', async () => {
    const root = await createRoot();
    const path = join(root, 'authority', 'launch.json');
    await createProtectedLocalStateFileExclusive(path, 'one-time-secret');

    await expect(consumeProtectedLocalStateFile(path)).resolves.toBe('one-time-secret');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('protected local state Windows ACL boundary', () => {
  it('applies and verifies current-user and SYSTEM-only non-inherited ACLs through the command boundary', async () => {
    const run = vi.fn<WindowsProtectedLocalStateCommandRunner>(async (command) => {
      if (command === 'whoami.exe') {
        return { exitCode: 0, stdout: '"USER","S-1-5-21-123"\r\n', stderr: '' };
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
    const boundary = createWindowsProtectedLocalStateAclBoundary({ runCommand: run });

    await boundary.applyAndVerify({ path: 'C:\\Users\\user\\.happier\\authority', kind: 'directory' });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      'whoami.exe',
      'icacls.exe',
      'icacls.exe',
      'powershell.exe',
    ]);
    expect(run.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['/setowner', '*S-1-5-21-123']));
    const icaclsArgs = run.mock.calls[2]?.[1] ?? [];
    expect(icaclsArgs).toContain('/inheritancelevel:r');
    expect(icaclsArgs).toContain('*S-1-5-21-123:(OI)(CI)F');
    expect(icaclsArgs).toContain('*S-1-5-18:(OI)(CI)F');
  });

  it('verifies an existing file without mutating its ACL', async () => {
    const root = await createRoot();
    const path = join(root, 'existing.json');
    await writeFile(path, 'secret');
    const run = vi.fn<WindowsProtectedLocalStateCommandRunner>(async (command) => {
      if (command === 'whoami.exe') {
        return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      }
      if (command === 'powershell.exe') {
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
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(readProtectedLocalStateFile(path, {
      platform: 'win32',
      windowsAclBoundary: createWindowsProtectedLocalStateAclBoundary({ runCommand: run }),
    })).resolves.toBe('secret');
    expect(run.mock.calls.map(([command]) => command)).toEqual(['whoami.exe', 'powershell.exe']);
  });

  it('applies the Windows file ACL before writing protected contents', async () => {
    const root = await createRoot();
    const path = join(root, 'authority', 'state.json');
    let observedFileContents: string | null = null;

    await createProtectedLocalStateFileExclusive(path, 'secret', {
      platform: 'win32',
      windowsAclBoundary: {
        async applyAndVerify(input) {
          if (input.kind === 'file') {
            observedFileContents = await readFile(input.path, 'utf8');
          }
        },
        async verify() {},
      },
    });

    expect(observedFileContents).toBe('');
    expect(await readFile(path, 'utf8')).toBe('secret');
  });

  it.each([
    ['command failure', async () => ({ exitCode: 1, stdout: '', stderr: 'denied' })],
    ['unexpected ACE', async (command: string) => command === 'whoami.exe'
      ? { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' }
      : command === 'icacls.exe'
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ ownerSid: 'S-1-5-21-123', protected: true, reparsePoint: false, rules: [{ sid: 'S-1-1-0', type: 'Allow', inherited: false, rights: 'Read' }] }), stderr: '' }],
    ['reparse point', async (command: string) => command === 'whoami.exe'
      ? { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' }
      : command === 'icacls.exe'
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ ownerSid: 'S-1-5-21-123', protected: true, reparsePoint: true, rules: [] }), stderr: '' }],
  ])('fails closed on %s', async (_label, implementation) => {
    const boundary = createWindowsProtectedLocalStateAclBoundary({
      runCommand: vi.fn(implementation) as WindowsProtectedLocalStateCommandRunner,
    });
    await expect(boundary.applyAndVerify({ path: 'C:\\state', kind: 'file' })).rejects.toThrow();
  });
});
