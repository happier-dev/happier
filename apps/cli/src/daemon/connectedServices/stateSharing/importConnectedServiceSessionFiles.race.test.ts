import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { copyFileSpy } = vi.hoisted(() => ({
  copyFileSpy: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: copyFileSpy,
  };
});

import { importConnectedServiceSessionFiles } from './importConnectedServiceSessionFiles';

describe('importConnectedServiceSessionFiles disappearing source races', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    copyFileSpy.mockReset();
  });

  it('skips a session file that disappears between enumeration and copy instead of failing the whole import', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    copyFileSpy.mockImplementation(async (sourcePath: string, destinationPath: string) => {
      if (sourcePath.endsWith('vanishing.jsonl')) {
        const error = new Error(`ENOENT: no such file or directory, copyfile '${sourcePath}' -> '${destinationPath}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return await actualFs.copyFile(sourcePath, destinationPath);
    });

    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-race-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'stable.jsonl'), '{"id":"stable"}\n');
    await writeFile(join(sourceRoot, 'vanishing.jsonl'), '{"id":"vanishing"}\n');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      conflicted: 0,
    });
    expect(result.details).toEqual([
      expect.objectContaining({
        relativePath: 'stable.jsonl',
        action: 'imported',
      }),
    ]);
    await expect(readFile(join(destinationRoot, 'stable.jsonl'), 'utf8')).resolves.toBe('{"id":"stable"}\n');
    await expect(readFile(join(destinationRoot, 'vanishing.jsonl'), 'utf8')).rejects.toThrow();
  });
});
