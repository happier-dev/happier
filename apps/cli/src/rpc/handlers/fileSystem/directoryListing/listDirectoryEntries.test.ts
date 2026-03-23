import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listDirectoryEntries } from './listDirectoryEntries';

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'happier-directory-listing-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('listDirectoryEntries', () => {
  it('sorts directories before files and returns direct children only', async () => {
    const root = createTempDirectory();
    mkdirSync(join(root, 'z-folder'));
    mkdirSync(join(root, 'a-folder'));
    mkdirSync(join(root, 'a-folder', 'nested'));
    writeFileSync(join(root, 'b-file.txt'), 'b');
    writeFileSync(join(root, 'a-file.txt'), 'a');

    const result = await listDirectoryEntries({
      directoryPath: root,
      includeFiles: true,
      maxEntries: null,
      statConcurrency: 4,
    });

    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => [entry.name, entry.type])).toEqual([
      ['a-folder', 'directory'],
      ['z-folder', 'directory'],
      ['a-file.txt', 'file'],
      ['b-file.txt', 'file'],
    ]);
    expect(result.entries.some((entry) => entry.absolutePath.endsWith('nested'))).toBe(false);
  });

  it('can hide files and report truncation when maxEntries is applied', async () => {
    const root = createTempDirectory();
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'beta'));
    writeFileSync(join(root, 'notes.txt'), 'hello');

    const directoriesOnly = await listDirectoryEntries({
      directoryPath: root,
      includeFiles: false,
      maxEntries: null,
      statConcurrency: 4,
    });

    expect(directoriesOnly.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta']);

    const truncated = await listDirectoryEntries({
      directoryPath: root,
      includeFiles: true,
      maxEntries: 2,
      statConcurrency: 4,
    });

    expect(truncated.entries).toHaveLength(2);
    expect(truncated.truncated).toBe(true);
  });
});
