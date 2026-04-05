import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const uiPackagePath = join(repoRoot, 'apps', 'ui', 'package.json');

test('ui postinstall runner skips installed package context and respects npm_execpath', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  const postinstallScript = String(uiPackageJson?.scripts?.postinstall ?? '');
  assert.ok(postinstallScript.length > 0, 'apps/ui package.json must define scripts.postinstall');
  assert.match(
    postinstallScript,
    /node_modules/i,
    'postinstall should no-op inside node_modules installs'
  );
  assert.match(
    postinstallScript,
    /npm_execpath/,
    'postinstall should prefer npm_execpath when available'
  );
  assert.match(
    postinstallScript,
    /process\.execPath/,
    'postinstall should execute npm_execpath via process.execPath'
  );
  assert.match(
    postinstallScript,
    /if\(r\.error\)/,
    'postinstall should surface spawn errors explicitly'
  );
  assert.match(
    postinstallScript,
    /postinstall:real/,
    'postinstall runner should continue to delegate to postinstall:real'
  );
});

test('ui postinstall runtime owns patch-package as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['patch-package'],
    '^8.0.0',
    'apps/ui postinstall requires patch-package during EAS/local installs, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['patch-package'],
    undefined,
    'apps/ui should not keep patch-package in devDependencies once postinstall depends on it at install time'
  );
});

test('ui Metro/Babel runtime owns babel-plugin-module-resolver as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['babel-plugin-module-resolver'],
    '^5.0.2',
    'apps/ui Metro bundling requires babel-plugin-module-resolver during EAS/local builds, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['babel-plugin-module-resolver'],
    undefined,
    'apps/ui should not keep babel-plugin-module-resolver in devDependencies once production bundling depends on it'
  );
});

test('ui production Metro/Babel runtime owns babel-plugin-transform-remove-console as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['babel-plugin-transform-remove-console'],
    '^6.9.4',
    'apps/ui production Metro bundling requires babel-plugin-transform-remove-console during EAS/local builds, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['babel-plugin-transform-remove-console'],
    undefined,
    'apps/ui should not keep babel-plugin-transform-remove-console in devDependencies once production bundling depends on it'
  );
});
