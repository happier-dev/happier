import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { setBundleReadOnly } from './build_source_runtime.mjs';
import { emitSourceAuthorPackages } from './source_author_packages.mjs';

test('author compiler failure removes its read-only preparation tree and preserves the cause', async t => {
  const fixture = await createTempFixture(t, {
    prefix: 'hstack-author-cleanup-',
    beforeCleanup: root => setBundleReadOnly(root, false),
  });
  const failure = new Error('author compiler failed');
  let workDir;
  await assert.rejects(emitSourceAuthorPackages({
    repoDir: fixture.root, runtimeDir: fixture.root,
    // The compiler is an external boundary. Its partial output has the same
    // permissions as the retained author captures that preparation can copy.
    build: async ({ outfile }) => {
      workDir = dirname(outfile);
      const capture = join(workDir, 'dist', '.happier-source');
      await mkdir(capture, { recursive: true });
      const file = join(capture, 'index.ts');
      await writeFile(file, 'export {};\n');
      await chmod(file, 0o444);
      await chmod(capture, 0o555);
      await chmod(dirname(capture), 0o555);
      throw failure;
    },
  }), error => error === failure);
  assert.ok(workDir, 'the compiler boundary must run');
  await assert.rejects(readdir(workDir), { code: 'ENOENT' });
});
