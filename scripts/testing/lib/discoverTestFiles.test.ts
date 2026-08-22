import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { discoverTestFiles } from './discoverTestFiles.ts';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'discoverTestFiles-'));
}

function writeTest(rootDir: string, relativePath: string): void {
  const absolute = join(rootDir, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, 'export {};\n', 'utf8');
}

test('skips the transient build-staging snapshots `apps/cli/scripts/build.mjs` creates beside the sources it copies', () => {
  const rootDir = fixture();
  try {
    // The CLI build snapshots its own sources into `.tmp.hstack-cli-build-source.<random>`
    // (apps/cli/scripts/build.mjs), and its own walker excludes that prefix. A build racing
    // this walk must not duplicate every discovered test into a second, doomed path: the
    // duplicates inflate every lane count and are reported as issues that name a directory
    // which no longer exists by the time anyone reads them.
    writeTest(rootDir, 'apps/cli/src/api/real.test.ts');
    writeTest(rootDir, 'apps/cli/.tmp.hstack-cli-build-source.G9hniE/src/api/real.test.ts');

    assert.deepEqual(discoverTestFiles({ rootDir, searchRoots: ['apps'] }), [
      'apps/cli/src/api/real.test.ts',
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('still discovers ordinary dot-directories that are not transient staging trees', () => {
  const rootDir = fixture();
  try {
    writeTest(rootDir, 'apps/ui/.storybook/preview.test.ts');

    assert.deepEqual(discoverTestFiles({ rootDir, searchRoots: ['apps'] }), [
      'apps/ui/.storybook/preview.test.ts',
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
