import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  const cwd = process.cwd();
  return existsSync(resolve(cwd, 'apps/cli/package.json')) ? cwd : resolve(cwd, '../..');
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(entryPath);
      return [entryPath];
    }),
  );
  return nested.flat();
}

function toRepoRelativePath(path: string): string {
  return relative(repoRoot(), path).split(sep).join('/');
}

function isProductionSourceFile(path: string): boolean {
  const relativePath = toRepoRelativePath(path);
  const extension = extname(path);
  return (
    ['.ts', '.tsx', '.mts', '.cts'].includes(extension) &&
    !relativePath.includes('/__tests__/') &&
    !relativePath.includes('.test.') &&
    !relativePath.includes('.spec.')
  );
}

async function findProductionMessageQueue2Allocators(): Promise<
  Array<{ relativePath: string; matchCount: number }>
> {
  const root = repoRoot();
  const sourceRoot = resolve(root, 'apps/cli/src');
  const files = await collectFiles(sourceRoot);
  const matches: Array<{ relativePath: string; matchCount: number }> = [];

  for (const file of files.filter(isProductionSourceFile)) {
    const source = await readFile(file, 'utf8');
    const matchCount = source.match(/\bnew\s+MessageQueue2\b/g)?.length ?? 0;
    if (matchCount > 0) matches.push({ relativePath: toRepoRelativePath(file), matchCount });
  }

  return matches.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

describe('createPermissionModeQueueState architecture', () => {
  it('keeps production MessageQueue2 allocation centralized in the permission queue state owner', async () => {
    await expect(findProductionMessageQueue2Allocators()).resolves.toEqual([
      {
        relativePath: 'apps/cli/src/agent/runtime/createPermissionModeQueueState.ts',
        matchCount: 1,
      },
    ]);
  });
});
