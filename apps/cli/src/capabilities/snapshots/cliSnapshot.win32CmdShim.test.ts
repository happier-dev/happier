import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const SCOPED_ENV_KEYS = ['PATH', 'PATHEXT', 'HAPPIER_CODEX_PATH', 'ComSpec'] as const;
type ScopedEnvKey = (typeof SCOPED_ENV_KEYS)[number];
const envBaseline = Object.fromEntries(
  SCOPED_ENV_KEYS.map((key) => [key, (process.env as any)[key] as string | undefined]),
) as Record<ScopedEnvKey, string | undefined>;

describe('detectCliSnapshotOnDaemonPath (Windows cmd shim)', () => {
  let workDir: string | null = null;

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
    for (const key of SCOPED_ENV_KEYS) {
      const value = envBaseline[key];
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
    vi.doUnmock('child_process');
    vi.doUnmock('@/backends/catalog');
    vi.resetModules();
    vi.restoreAllMocks();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  });

  it('uses windowsVerbatimArguments when executing .cmd CLIs via cmd.exe', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'win32' });

    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex' },
      },
    }));

    workDir = mkdtempSync(join(tmpdir(), 'happier-cliSnapshot-win32-'));
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const codexCmd = join(binDir, 'codex.cmd');
    writeFileSync(codexCmd, '@echo off\r\necho codex 0.43.0\r\n', 'utf8');
    process.env.HAPPIER_CODEX_PATH = codexCmd;
    process.env.PATH = binDir;
    process.env.PATHEXT = '.CMD';
    delete (process.env as any).ComSpec;

    const execFileMock = vi.fn((file: any, args: any, options: any, cb: any) => {
      if (typeof options === 'function') {
        cb = options;
        options = undefined;
      }
      cb(null, 'codex 0.43.0\n', '');
      return { pid: 1 } as any;
    });

    vi.doMock('child_process', () => ({ execFile: execFileMock }));

    const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');
    const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });

    expect(snapshot.clis.codex.available).toBe(true);

    expect(execFileMock).toHaveBeenCalled();
    const [command, calledArgs, calledOptions] = execFileMock.mock.calls[0] ?? [];
    expect(command).toBe('cmd.exe');
    expect(calledArgs?.slice?.(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(calledArgs?.[3]).toContain('codex.cmd');
    expect(calledOptions).toEqual(expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }));
  });
});
