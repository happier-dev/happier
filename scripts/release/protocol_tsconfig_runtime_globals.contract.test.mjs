import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('protocol tsconfig declares the Web runtime libs required by its packaged postinstall build', async () => {
  const raw = await readFile(resolve(repoRoot, 'packages/protocol/tsconfig.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const libs = parsed?.compilerOptions?.lib;

  assert.ok(Array.isArray(libs), 'packages/protocol/tsconfig.json should declare compilerOptions.lib');
  assert.ok(
    libs.includes('DOM'),
    'packages/protocol/tsconfig.json should include DOM so isolated package builds typecheck URL/fetch/TextEncoder globals'
  );
  assert.ok(
    libs.includes('DOM.Iterable'),
    'packages/protocol/tsconfig.json should include DOM.Iterable so fetch-related Web types stay self-contained in installed-package builds'
  );
});
