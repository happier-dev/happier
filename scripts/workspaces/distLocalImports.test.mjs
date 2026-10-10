import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import {
  assertNoMissingLocalImports,
  extractLocalImportSpecifiersFromJs,
  hasMissingLocalImportsSync,
} from './distLocalImports.mjs';

test('local import extraction ignores import-shaped text inside generated source strings and comments', () => {
  const source = [
    'const generatedTest = "const module = await import(\'../dist/index.js\');";',
    "const generatedTemplate = `export * from './generated-only.js';`;",
    "// import './comment-only.js';",
    "/* export { value } from './block-comment-only.js'; */",
    "import './real-side-effect.js';",
    "export { value } from './real-export.js';",
    "const runtimeModule = import('./real-dynamic.js');",
    '',
  ].join('\n');

  assert.deepEqual(
    extractLocalImportSpecifiersFromJs(source).sort(),
    ['./real-dynamic.js', './real-export.js', './real-side-effect.js'],
  );
});

test('local import validation accepts bundled generated source text while still traversing real imports', async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), 'happier-dist-local-imports-generated-source-'));
  t.after(async () => rm(distDir, { recursive: true, force: true }));

  const entrypoint = join(distDir, 'index.mjs');
  await mkdir(join(distDir, 'chunks'), { recursive: true });
  await writeFile(entrypoint, "import './chunks/scaffold.mjs';\n", 'utf8');
  await writeFile(
    join(distDir, 'chunks', 'scaffold.mjs'),
    [
      'export const generatedTest = [',
      '  "const module = await import(\'../dist/index.js\');",',
      '].join("\\n");',
      "export { ready } from './ready.mjs';",
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(distDir, 'chunks', 'ready.mjs'), 'export const ready = true;\n', 'utf8');

  await assert.doesNotReject(
    assertNoMissingLocalImports({
      distDir,
      entryPath: entrypoint,
      label: 'generated-source fixture',
    }),
  );
});

test('synchronous local import validation distinguishes complete and partial dist graphs', async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), 'happier-dist-local-imports-sync-'));
  t.after(async () => rm(distDir, { recursive: true, force: true }));

  const entrypoint = join(distDir, 'index.mjs');
  const dependency = join(distDir, 'dependency.mjs');
  await writeFile(entrypoint, "export { value } from './dependency.mjs';\n", 'utf8');

  assert.equal(hasMissingLocalImportsSync({ distDir, entryPaths: [entrypoint] }), true);

  await writeFile(dependency, 'export const value = true;\n', 'utf8');
  const read = fs.readFileSync;
  let reads = 0;
  const replacement = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path).startsWith(distDir)) reads += 1;
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(hasMissingLocalImportsSync({ distDir, entryPaths: [entrypoint] }), false);
  assert.equal(reads, 2, 'synchronous readiness reads each internal graph member once');
});

test('one package admission validates every entrypoint through a single shared import traversal', async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), 'happier-dist-local-imports-shared-'));
  t.after(async () => rm(distDir, { recursive: true, force: true }));
  const entries = [join(distDir, 'first.mjs'), join(distDir, 'second.mjs')];
  const shared = join(distDir, 'shared.mjs');
  await writeFile(entries[0], "export * from './shared.mjs';\n");
  await writeFile(entries[1], "export * from './shared.mjs';\nexport * from './second-only.mjs';\n");
  await writeFile(shared, "export * from './first.mjs';\n");
  await writeFile(join(distDir, 'second-only.mjs'), 'export const value = true;\n');

  // Observe the filesystem boundary with real reads: overlapping exports must
  // not multiply admission I/O, and cycles must still terminate.
  const read = fsPromises.readFile;
  const reads = new Map();
  const replacement = t.mock.method(fsPromises, 'readFile', async (path, ...args) => {
    if (String(path).startsWith(distDir)) reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
    return await read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports(); });
  await assertNoMissingLocalImports({ distDir, entryPath: entries[0], entryPaths: entries });
  assert.deepEqual([...reads.values()], [1, 1, 1, 1], 'each graph member is read once per admission');

  await rm(join(distDir, 'second-only.mjs'));
  await assert.rejects(assertNoMissingLocalImports({ distDir, entryPaths: entries }), /missing local imports/,
    'a new admission must observe damage on an entrypoint outside the first closure');
  await writeFile(join(distDir, 'second-only.mjs'), 'export const value = true;\n');
  await assert.doesNotReject(assertNoMissingLocalImports({ distDir, entryPaths: entries }),
    'failed admission must not retain visited state into recovery');
});

test('a finite package graph is admitted independently of the number of exported entries', async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), 'happier-dist-local-imports-finite-'));
  t.after(async () => rm(distDir, { recursive: true, force: true }));
  const entries = Array.from({ length: 5001 }, (_, index) => join(distDir, `${index}.mjs`));
  for (let offset = 0; offset < entries.length; offset += 100) {
    await Promise.all(entries.slice(offset, offset + 100).map(path => writeFile(path, 'export const value = true;\n')));
  }
  await assert.doesNotReject(assertNoMissingLocalImports({ distDir, entryPaths: entries }));
  assert.equal(hasMissingLocalImportsSync({ distDir, entryPaths: entries }), false);
});
