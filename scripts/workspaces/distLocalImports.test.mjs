import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.equal(hasMissingLocalImportsSync({ distDir, entryPaths: [entrypoint] }), false);
});
