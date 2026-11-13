import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runWithBackendRuntimeServices as runWithScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

import { normalizePathspec, normalizeRepoRootPathspec, normalizeRepoRootRelativePath, readScmEnvironment, runScmCommand } from './runtime.js';

describe('Git SCM plugin runtime', () => {
  it('requires an active host to provide the environment reader instead of borrowing the physical host environment', () => {
    expect(() => runWithScmBackendRuntimeServices({
      async runCommand() { throw new Error('No command is needed to read an environment'); },
    }, readScmEnvironment)).toThrow(expect.objectContaining({ code: 'BACKEND_UNAVAILABLE' }));
  });

  it('uses the standalone process environment when no host runtime service is installed', () => {
    vi.stubEnv('HAPPIER_SCM_STANDALONE_FIXTURE', 'standalone');
    try {
      expect(readScmEnvironment().HAPPIER_SCM_STANDALONE_FIXTURE).toBe('standalone');
    } finally { vi.unstubAllEnvs(); }
  });

  it('delegates command execution to the host SCM backend runtime service', async () => {
    const calls: unknown[] = [];

    const result = await runWithScmBackendRuntimeServices({
      async runCommand(input) {
        calls.push(input);
        return {
          success: true,
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
        };
      },
    }, async () => await runScmCommand({
      bin: 'git',
      cwd: '/repo',
      args: ['status', '--short'],
      timeoutMs: 123,
      stdin: 'input',
      maxOutputBytes: 456,
      env: { CUSTOM_VALUE: 'x' },
    }));

    expect(result).toEqual({
      success: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });
    expect(calls).toEqual([
      {
        installableKey: 'git-cli',
        command: 'git',
        cwd: '/repo',
        args: ['status', '--short'],
        timeoutMs: 123,
        stdin: 'input',
        maxOutputBytes: 456,
        env: {
          CUSTOM_VALUE: 'x',
          GIT_ALLOW_PROTOCOL: 'https:ssh:git:file',
        },
      },
    ]);
  });

  it('rejects root-equivalent selected mutation paths', () => {
    const cwd = process.cwd();

    for (const path of ['', '.', './', ':', ':(top)*', '-path']) {
      expect(normalizePathspec(path, cwd).ok).toBe(false);
    }

    expect(normalizePathspec('src/a.ts', cwd)).toMatchObject({
      ok: true,
      pathspec: 'src/a.ts',
    });
    expect(normalizePathspec(' ', cwd)).toMatchObject({ ok: true, pathspec: ' ' });
  });
});

describe('Git literal selection', () => {
    it('selects literal filenames and directory children from a nested cwd', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-literal-pathspec-'));
        try {
            execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
            mkdirSync(join(cwd, 'nested'));
            for (const name of ['literal[1].txt', 'literal1.txt', 'dir[1]', 'dir1']) {
                if (name.startsWith('dir')) {
                    mkdirSync(join(cwd, name));
                    writeFileSync(join(cwd, name, 'child.txt'), 'content');
                } else {
                    writeFileSync(join(cwd, name), 'content');
                }
            }
            execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
            for (const [input, expected] of [
                ['literal[1].txt', 'literal[1].txt'],
                ['dir[1]', 'dir[1]/child.txt'],
            ]) {
                const result = normalizeRepoRootPathspec(input);
                expect(result.ok).toBe(true);
                if (!result.ok) throw new Error(result.error);
                const selected = execFileSync('git', ['ls-files', '--full-name', '-z', '--', result.pathspec], {
                    cwd: join(cwd, 'nested'), encoding: 'utf8',
                }).split('\0').filter(Boolean);
                expect(selected).toEqual([expected]);
            }
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32').each([' leading\t\n', 'file ', ' '])('preserves literal filename whitespace for %j', (filename) => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-whitespace-pathspec-'));
        try {
            execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
            writeFileSync(join(cwd, filename), 'selected');
            writeFileSync(join(cwd, 'leading'), 'unrelated');
            execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
            const result = normalizeRepoRootRelativePath(filename);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            expect(result.relativePath).toBe(filename);
            expect(execFileSync('git', ['ls-files', '-z', '--', result.pathspec], { cwd, encoding: 'utf8' }))
                .toBe(`${filename}\0`);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

});
