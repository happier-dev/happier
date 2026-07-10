import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../src/testkit/fs/tempDir';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { main, resolveDistDir } from './rmDist.mjs';

const workspaceBundleLockModulePath = fileURLToPath(
  new URL('../../../scripts/workspaces/workspaceBundleLock.mjs', import.meta.url),
);

describe('rmDist', () => {
  it('defaults to dist when no directory is provided', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs'])).toBe('dist');
  });

  it('defaults to dist when the first arg looks like a flag', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '--foo'])).toBe('dist');
  });

  it('uses the first arg when it looks like a directory name', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', 'build-out'])).toBe('build-out');
  });

  it('rejects absolute paths', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '/'])).toBe('dist');
  });

  it('rejects path traversal segments', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '../../..'])).toBe('dist');
    expect(resolveDistDir(['node', 'rmDist.mjs', 'dist/../..'])).toBe('dist');
  });

  it('rejects dot segments (avoid deleting the current directory)', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '.'])).toBe('dist');
    expect(resolveDistDir(['node', 'rmDist.mjs', './dist'])).toBe('dist');
  });

  it('keeps the previous package-dist entrypoint available while removing dist', async () => {
    const rootDir = createTempDirSync('happier-cli-rm-dist-preserve-package-dist-');
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(rootDir, 'dist'), { recursive: true });
      mkdirSync(join(rootDir, 'package-dist'), { recursive: true });
      writeFileSync(join(rootDir, 'dist', 'index.mjs'), 'export const staleDist = true;\n', 'utf8');
      writeFileSync(join(rootDir, 'package-dist', 'index.mjs'), 'export const previous = true;\n', 'utf8');
      process.chdir(rootDir);

      await main(['node', 'rmDist.mjs'], {
        lockModulePath: '',
      });

      expect(existsSync(join(rootDir, 'dist', 'index.mjs'))).toBe(false);
      expect(existsSync(join(rootDir, 'package-dist', 'index.mjs'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('waits for the shared CLI build lock before removing dist', async () => {
    const rootDir = createTempDirSync('happier-cli-rm-dist-lock-');
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(rootDir, 'dist'), { recursive: true });
      mkdirSync(join(rootDir, 'package-dist'), { recursive: true });
      writeFileSync(join(rootDir, 'package-dist', 'index.mjs'), 'export const previous = true;\n', 'utf8');
      process.chdir(rootDir);

      const lockPath = resolve(rootDir, '.project', 'tmp', 'cli-shared-deps-build.lock');
      await withWorkspaceBundleLock(
        async () => {
          await expect(
            main(['node', 'rmDist.mjs'], {
              lockModulePath: workspaceBundleLockModulePath,
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            }),
          ).rejects.toThrow(/Timed out waiting for workspace bundle lock/);
          expect(existsSync(join(rootDir, 'package-dist', 'index.mjs'))).toBe(true);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
