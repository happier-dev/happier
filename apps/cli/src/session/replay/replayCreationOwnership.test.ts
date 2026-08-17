import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Import boundary for Replay-seeded Session creation.
 *
 * `createReplaySeededSession` was a second Session-row creator with its own
 * creation identity and its own orphan cleanup, alongside the canonical
 * `createSpawnedSession`. Every Replay ingress now builds its recipe through
 * `buildReplaySeededSpawnRecipe` and commits the row through the canonical
 * creator, so the duplicate creator must stay gone.
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
    const sourceFiles = await collectSourceFiles(CLI_SOURCE_ROOT);
    const offenders: string[] = [];
    for (const filePath of sourceFiles) {
      if (path.resolve(filePath) === path.resolve(__filename)) continue;
      const contents = await readFile(filePath, 'utf8');
      if (RETIRED_CREATOR_PATTERN.test(contents)) {
        offenders.push(path.relative(CLI_SOURCE_ROOT, filePath));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Every module that turns a Replay/source recipe into a Session must reach the
   * canonical creator. An ingress that accepts the request and drops the recipe
   * creates an ordinary blank Session and reports success — silently wrong — so
   * a new recipe consumer that never reaches the creator is a defect, not a gap.
   */
  it('routes every replay-recipe consumer through the canonical creator', async () => {
    const sourceFiles = await collectSourceFiles(CLI_SOURCE_ROOT);
    const offenders: string[] = [];
    for (const filePath of sourceFiles) {
      const relativePath = path.relative(CLI_SOURCE_ROOT, filePath);
      // The recipe owner's own directory builds recipes without creating rows.
      if (relativePath.startsWith(path.join('session', 'replay') + path.sep)) continue;
      if (/\.(test|spec)\.[cm]?tsx?$/.test(relativePath)) continue;
      const contents = await readFile(filePath, 'utf8');
      if (!contents.includes('buildReplaySeededSpawnRecipe')) continue;
      if (!contents.includes('createSpawnedSession')) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
