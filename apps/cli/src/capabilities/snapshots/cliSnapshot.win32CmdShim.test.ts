import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotEnvValues, restoreEnvValues } from '@/testkit/env/envSnapshot';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const SCOPED_ENV_KEYS = ['PATH', 'PATHEXT', 'HAPPIER_CODEX_PATH', 'ComSpec'] as const;
type ScopedEnvKey = (typeof SCOPED_ENV_KEYS)[number];
const envBaseline = snapshotEnvValues(SCOPED_ENV_KEYS) as Record<ScopedEnvKey, string | undefined>;

describe('detectCliSnapshotOnDaemonPath (Windows cmd shim)', () => {
  let workDir: string | null = null;

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
    restoreEnvValues(envBaseline);
    vi.doUnmock('@happier-dev/cli-common/process');
    vi.resetModules();
    vi.restoreAllMocks();
    if (workDir) removeTempDirSync(workDir);
    workDir = null;
  });

  it('uses windowsVerbatimArguments when executing .cmd CLIs via cmd.exe', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'win32' });

    vi.resetModules();

    workDir = createTempDirSync('happier-cliSnapshot-win32-');
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const codexCmd = writeExecutableShimSync({
      dir: binDir,
      fileName: 'codex.cmd',
      contents: '@echo off\r\necho codex 0.43.0\r\n',
    });
    process.env.HAPPIER_CODEX_PATH = codexCmd;
    process.env.PATH = binDir;
    process.env.PATHEXT = '.CMD';
    delete process.env.ComSpec;

    const execFileMock = vi.fn<typeof import('@happier-dev/cli-common/process').execFileWithDeadline>()
      .mockResolvedValue({ stdout: 'codex 0.43.0\n', stderr: '' });

    // Preserve real catalog and command resolution; replace only the OS execution boundary.
    vi.doMock('@happier-dev/cli-common/process', async (importOriginal) => ({
      ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
      execFileWithDeadline: execFileMock,
    }));

    const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');
    const snapshot = await detectCliSnapshotOnDaemonPath({ requestedCliNames: ['codex'], requestedTools: [], includeLoginStatus: false });

    expect(snapshot.clis.codex.available).toBe(true);

    expect(execFileMock).toHaveBeenCalled();
    const [command, calledArgs, calledOptions] = execFileMock.mock.calls[0] ?? [];
    expect(command).toBe('cmd.exe');
    expect(calledArgs?.slice?.(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(calledArgs?.[3]).toContain('codex.cmd');
    expect(calledOptions).toEqual(expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }));
  });
});
