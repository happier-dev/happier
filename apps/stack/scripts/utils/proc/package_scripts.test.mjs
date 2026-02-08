import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectPackageManagerCmd, pickFirstScript, readPackageJsonScripts } from './package_scripts.mjs';

test('detectPackageManagerCmd prefers yarn when run from a Happy monorepo package dir (packages/ layout)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-package-scripts-happy-monorepo-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal monorepo markers + yarn.lock at the monorepo root.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  const pm = await detectPackageManagerCmd(join(root, 'apps', 'server'));
  assert.equal(pm.name, 'yarn');
  assert.deepEqual(pm.argsForScript('test'), ['-s', 'test']);
});

test('detectPackageManagerCmd defaults to yarn when no lockfile/monorepo markers are present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-package-scripts-default-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'package.json'), '{ "name": "single-package" }\n', 'utf-8');

  const pm = await detectPackageManagerCmd(root);
  assert.equal(pm.name, 'yarn');
  assert.deepEqual(pm.argsForScript('lint'), ['-s', 'lint']);
});

test('readPackageJsonScripts returns scripts object or null for missing package.json', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-package-scripts-read-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(await readPackageJsonScripts(root), null);
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }), 'utf-8');
  assert.deepEqual(await readPackageJsonScripts(root), { test: 'vitest', lint: 'eslint .' });
});

test('pickFirstScript returns the first non-empty script in candidate order', () => {
  const scripts = { test: ' ', check: 'vitest', lint: 'eslint .' };
  assert.equal(pickFirstScript(scripts, ['test', 'check', 'lint']), 'check');
  assert.equal(pickFirstScript(scripts, ['missing', 'lint']), 'lint');
  assert.equal(pickFirstScript(scripts, ['missing']), null);
});
