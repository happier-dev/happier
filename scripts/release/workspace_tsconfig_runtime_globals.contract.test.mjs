import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readJson(relativePath) {
  const raw = await readFile(resolve(repoRoot, relativePath), 'utf8');
  return JSON.parse(raw);
}

test('protocol tsconfig declares the Web runtime libs required by its packaged postinstall build', async () => {
  const parsed = await readJson('packages/protocol/tsconfig.json');
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

test('transfers packaged postinstall build declares the Web and Node runtime globals it uses', async () => {
  const tsconfig = await readJson('packages/transfers/tsconfig.json');
  const packageJson = await readJson('packages/transfers/package.json');
  const libs = tsconfig?.compilerOptions?.lib;
  const types = tsconfig?.compilerOptions?.types;

  assert.ok(Array.isArray(libs), 'packages/transfers/tsconfig.json should declare compilerOptions.lib');
  assert.ok(
    libs.includes('DOM'),
    'packages/transfers/tsconfig.json should include DOM so isolated package builds typecheck URL'
  );
  assert.ok(Array.isArray(types), 'packages/transfers/tsconfig.json should declare compilerOptions.types');
  assert.ok(
    types.includes('node'),
    'packages/transfers/tsconfig.json should include node types so isolated package builds typecheck process/NodeJS globals'
  );
  assert.equal(
    packageJson?.devDependencies?.['@types/node'],
    '>=20',
    'packages/transfers/package.json should declare @types/node for its Node-typed postinstall build'
  );
});

test('agents packaged postinstall build declares the Web runtime globals it uses', async () => {
  const tsconfig = await readJson('packages/agents/tsconfig.json');
  const libs = tsconfig?.compilerOptions?.lib;

  assert.ok(Array.isArray(libs), 'packages/agents/tsconfig.json should declare compilerOptions.lib');
  assert.ok(
    libs.includes('DOM'),
    'packages/agents/tsconfig.json should include DOM so isolated package builds typecheck URL'
  );
});

test('release-runtime packaged postinstall build declares the Web and Node runtime globals it uses', async () => {
  const tsconfig = await readJson('packages/release-runtime/tsconfig.json');
  const packageJson = await readJson('packages/release-runtime/package.json');
  const libs = tsconfig?.compilerOptions?.lib;
  const types = tsconfig?.compilerOptions?.types;

  assert.ok(Array.isArray(libs), 'packages/release-runtime/tsconfig.json should declare compilerOptions.lib');
  assert.ok(
    libs.includes('DOM'),
    'packages/release-runtime/tsconfig.json should include DOM so isolated package builds typecheck fetch/URL'
  );
  assert.ok(Array.isArray(types), 'packages/release-runtime/tsconfig.json should declare compilerOptions.types');
  assert.ok(
    types.includes('node'),
    'packages/release-runtime/tsconfig.json should include node types so isolated package builds typecheck Buffer/node:* imports'
  );
  assert.equal(
    packageJson?.devDependencies?.['@types/node'],
    '>=20',
    'packages/release-runtime/package.json should declare @types/node for its Node-typed postinstall build'
  );
});
