import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Import boundary for Replay-seeded Session creation.
 *
 * `createReplaySeededSession` was a second Session-row creator with its own
 * creation identity and its own orphan cleanup, alongside the canonical
 * `createSpawnedSession`. Both replay ingresses now build their recipe through
 * `buildReplaySeededSpawnRecipe` and create through the canonical creator, so
 * the duplicate creator must stay gone.
 */
const CLI_SOURCE_ROOT = path.resolve(__dirname, '../..');
const RETIRED_CREATOR_PATH = path.join(CLI_SOURCE_ROOT, 'session/replay/createReplaySeededSession.ts');
const RETIRED_CREATOR_PATTERN = /createReplaySeededSession/;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.turbo']);

async function collectSourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...await collectSourceFiles(entryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(entryPath);
  }
  return files;
}

describe('replay-seeded Session creation ownership', () => {
  it('has no duplicate replay-seeded Session creator module', () => {
    expect(existsSync(RETIRED_CREATOR_PATH)).toBe(false);
  });

  it('has no source reference to the retired duplicate creator', async () => {
    const sourceFiles = (await collectSourceFiles(CLI_SOURCE_ROOT))
      .filter((filePath) => path.resolve(filePath) !== path.resolve(__filename));
    const offenders: string[] = [];
    const readConcurrency = 64;
    for (let index = 0; index < sourceFiles.length; index += readConcurrency) {
      const batch = sourceFiles.slice(index, index + readConcurrency);
      const contents = await Promise.all(batch.map((filePath) => readFile(filePath, 'utf8')));
      contents.forEach((text, offset) => {
        if (RETIRED_CREATOR_PATTERN.test(text)) {
          offenders.push(path.relative(CLI_SOURCE_ROOT, batch[offset] as string));
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
