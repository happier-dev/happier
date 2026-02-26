import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const ORIGINAL_HOME = process.env.HAPPIER_HOME_DIR;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PATHEXT = process.env.PATHEXT;
const ORIGINAL_COMSPEC = (process.env as any).ComSpec;

const tempDirs = new Set<string>();

afterEach(async () => {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
  }

  if (ORIGINAL_HOME === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_HOME;

  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;

  if (ORIGINAL_PATHEXT === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = ORIGINAL_PATHEXT;

  if (ORIGINAL_COMSPEC === undefined) delete (process.env as any).ComSpec;
  else (process.env as any).ComSpec = ORIGINAL_COMSPEC;

  vi.doUnmock('child_process');
  vi.resetModules();
  vi.restoreAllMocks();

  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('codexMcpResume npm invocation (Windows)', () => {
  it('wraps npm view with cmd.exe on win32 (PATHEXT .CMD)', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }

    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'win32' });

    const home = await mkdtemp(join(tmpdir(), 'happier-codex-resume-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const binDir = await mkdtemp(join(tmpdir(), 'happier-codex-resume-bin-'));
    tempDirs.add(binDir);
    await writeFile(join(binDir, 'npm.CMD'), '@echo off\r\necho ok\r\n', 'utf8');
    process.env.PATH = binDir;
    process.env.PATHEXT = '.CMD';
    delete (process.env as any).ComSpec;

    const execFileMock = vi.fn((file: any, args: any, options: any, cb: any) => {
      if (typeof options === 'function') {
        cb = options;
        options = undefined;
      }
      cb(null, '1.2.3\n', '');
      return { pid: 1 } as any;
    });

    vi.doMock('child_process', () => ({ execFile: execFileMock }));

    const { getCodexMcpResumeDepStatus } = await import('./codexMcpResume');
    await expect(getCodexMcpResumeDepStatus({ includeRegistry: true })).resolves.toEqual(
      expect.objectContaining({
        registry: expect.objectContaining({ ok: true }),
      }),
    );

    expect(execFileMock).toHaveBeenCalled();
    const [command, calledArgs, calledOptions] = execFileMock.mock.calls[0] ?? [];
    expect(command).toBe('cmd.exe');
    expect(calledArgs?.slice?.(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(calledArgs?.[3]).toContain('npm.CMD');
    expect(calledArgs?.[3]).toContain('view');
    expect(calledOptions).toEqual(expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }));
  });

  it('wraps npm install with cmd.exe on win32 (PATHEXT .CMD)', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }

    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'win32' });

    const home = await mkdtemp(join(tmpdir(), 'happier-codex-resume-install-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const binDir = await mkdtemp(join(tmpdir(), 'happier-codex-resume-install-bin-'));
    tempDirs.add(binDir);
    await writeFile(join(binDir, 'npm.CMD'), '@echo off\r\necho ok\r\n', 'utf8');
    process.env.PATH = binDir;
    process.env.PATHEXT = '.CMD';
    delete (process.env as any).ComSpec;

    const execFileMock = vi.fn((file: any, args: any, options: any, cb: any) => {
      if (typeof options === 'function') {
        cb = options;
        options = undefined;
      }
      cb(null, '', '');
      return { pid: 1 } as any;
    });

    vi.doMock('child_process', () => ({ execFile: execFileMock }));

    const { installCodexMcpResume } = await import('./codexMcpResume');
    await expect(installCodexMcpResume()).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(execFileMock).toHaveBeenCalled();
    const [command, calledArgs, calledOptions] = execFileMock.mock.calls[0] ?? [];
    expect(command).toBe('cmd.exe');
    expect(calledArgs?.slice?.(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(calledArgs?.[3]).toContain('npm.CMD');
    expect(calledArgs?.[3]).toContain('install');
    expect(calledOptions).toEqual(expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }));
  });
});

