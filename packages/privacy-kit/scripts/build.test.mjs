import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { collectDistOutputFiles } from './build.mjs';

test('pkgroll builds packaged exports without treating explicit source conditions as dist output', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(collectDistOutputFiles(manifest).sort(), ['index.cjs', 'index.d.cts', 'index.d.mts', 'index.mjs']);
  assert.throws(() => collectDistOutputFiles({ exports: { default: './unexpected/index.js' } }), /inside \.\/dist/);
});
