import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RETIRED_SOURCE_DIRECTORIES = [
  'workspaces/replication',
  'session/handoff/workspaceReplication',
] as const;

const RETIRED_IMPORT_PATTERN = /(?:from\s+|import\s*\()\s*['"][^'"]*(?:workspaces\/replication|session\/handoff\/workspaceReplication)(?:\/|['"])/u;

async function collectSourceFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(entryPath));
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) {
      continue;
    }
    // Tests may mention retired paths while asserting compatibility behavior;
    // production imports are the architecture boundary guarded here.
    if (/(?:\.test|\.spec|\.architecture)\.tsx?$/u.test(entry.name)) {
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

describe('workspace sync legacy surface architecture', () => {
  it('does not retain retired workspace replication source trees', async () => {
    const sourceRoot = new URL('../../', import.meta.url);
    for (const relativePath of RETIRED_SOURCE_DIRECTORIES) {
      const retiredRoot = fileURLToPath(new URL(`${relativePath}/`, sourceRoot));
      const files = await collectSourceFiles(retiredRoot).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return [];
        }
        throw error;
      });
      expect(files).toEqual([]);
    }
  });

  it('keeps retired workspace replication imports out of production sources', async () => {
    const sourceRoot = new URL('../../', import.meta.url);
    const sourceFiles = await collectSourceFiles(fileURLToPath(sourceRoot));
    const violations: string[] = [];
    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, 'utf8');
      if (RETIRED_IMPORT_PATTERN.test(source)) {
        violations.push(sourceFile);
      }
    }
    expect(violations).toEqual([]);
  });
});
