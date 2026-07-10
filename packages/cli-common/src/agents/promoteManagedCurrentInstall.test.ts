import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { failingRenameTargets } = vi.hoisted(() => ({
  failingRenameTargets: new Map<string, number>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      const remainingFailures = failingRenameTargets.get(to) ?? 0;
      if (remainingFailures > 0) {
        if (remainingFailures === 1) {
          failingRenameTargets.delete(to);
        } else {
          failingRenameTargets.set(to, remainingFailures - 1);
        }
        const error = new Error(`EXDEV: mocked promotion failure, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      }
      return await actual.rename(from, to);
    }),
  };
});

const tempDirs = new Set<string>();

async function makeTempRoot(): Promise<string> {
  const root = join(tmpdir(), `happier-managed-current-promotion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.add(root);
  await mkdir(root, { recursive: true });
  return root;
}

describe('promoteManagedCurrentInstall', () => {
  afterEach(async () => {
    failingRenameTargets.clear();
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
    vi.resetModules();
  });

  it('restores the previous current install when final candidate promotion fails', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const nextPath = join(installRoot, 'next');
    const binaryPath = join(currentPath, 'bin', 'tool');

    await mkdir(join(currentPath, 'bin'), { recursive: true });
    await writeFile(binaryPath, 'old-current', 'utf8');
    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'new-next', 'utf8');
    failingRenameTargets.set(currentPath, 1);

    await expect(promoteManagedCurrentInstall({ installRoot })).rejects.toThrow(/promotion failure/i);

    await expect(readFile(binaryPath, 'utf8')).resolves.toBe('old-current');
    await expect(readFile(join(nextPath, 'bin', 'tool'), 'utf8')).resolves.toBe('new-next');
  });
});
