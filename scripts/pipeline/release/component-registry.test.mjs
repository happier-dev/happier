import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyChangedPaths, deriveVersionedComponentChanges } from './component-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function listInternalDependencyDirs({ dependencies, bundledDependencies }) {
  const names = new Set();
  for (const dep of Object.keys(dependencies ?? {})) {
    if (dep.startsWith('@happier-dev/')) names.add(dep);
  }
  for (const dep of bundledDependencies ?? []) {
    if (typeof dep === 'string' && dep.startsWith('@happier-dev/')) names.add(dep);
  }
  return Array.from(names)
    .map((name) => name.split('/')[1])
    .filter(Boolean);
}

function assertInternalPackagesExist(dirs) {
  const missing = [];
  for (const dir of dirs) {
    if (!fs.existsSync(join(repoRoot, 'packages', dir))) missing.push(dir);
  }
  assert.deepEqual(missing, [], `expected workspace package dirs to exist: ${missing.join(', ')}`);
}

function assertDependencyDirsTriggerVersionedChange({ id, dirs, expected }) {
  for (const dir of dirs) {
    const classified = classifyChangedPaths([`packages/${dir}/src/index.ts`]);
    const versioned = deriveVersionedComponentChanges(classified);
    assert.equal(versioned[expected], true, `${id}: expected packages/${dir} change to flip versioned.${expected}`);
  }
}

test('versioned component changes include internal workspace dependency changes', () => {
  const uiPkg = readJson(join(repoRoot, 'apps', 'ui', 'package.json'));
  const cliPkg = readJson(join(repoRoot, 'apps', 'cli', 'package.json'));
  const stackPkg = readJson(join(repoRoot, 'apps', 'stack', 'package.json'));
  const serverPkg = readJson(join(repoRoot, 'apps', 'server', 'package.json'));
  const relayServerPkg = readJson(join(repoRoot, 'packages', 'relay-server', 'package.json'));

  const appDirs = listInternalDependencyDirs({ dependencies: uiPkg.dependencies });
  const cliDirs = listInternalDependencyDirs({ bundledDependencies: cliPkg.bundledDependencies });
  const stackDirs = listInternalDependencyDirs({ bundledDependencies: stackPkg.bundledDependencies });
  const serverDirs = [
    ...listInternalDependencyDirs({ dependencies: serverPkg.dependencies }),
    ...listInternalDependencyDirs({ bundledDependencies: relayServerPkg.bundledDependencies }),
  ];

  assertInternalPackagesExist(appDirs);
  assertInternalPackagesExist(cliDirs);
  assertInternalPackagesExist(stackDirs);
  assertInternalPackagesExist(serverDirs);

  assertDependencyDirsTriggerVersionedChange({ id: 'app', dirs: appDirs, expected: 'app' });
  assertDependencyDirsTriggerVersionedChange({ id: 'cli', dirs: cliDirs, expected: 'cli' });
  assertDependencyDirsTriggerVersionedChange({ id: 'stack', dirs: stackDirs, expected: 'stack' });
  assertDependencyDirsTriggerVersionedChange({ id: 'server', dirs: serverDirs, expected: 'server' });
});

test('root dependency graph changes select every versioned release artifact', () => {
  for (const path of ['package.json', 'yarn.lock']) {
    const versioned = deriveVersionedComponentChanges(classifyChangedPaths([path]));
    assert.deepEqual({ ...versioned }, {
      app: true,
      cli: true,
      stack: true,
      server: true,
    }, path);
  }
});

test('bootstrap changes select the UI app artifact that embeds the hsetup sidecar', () => {
  const versioned = deriveVersionedComponentChanges(classifyChangedPaths([
    'apps/bootstrap/src/bin/hsetup.ts',
  ]));
  assert.equal(versioned.app, true);
  assert.equal(versioned.cli, false);
  assert.equal(versioned.stack, false);
  assert.equal(versioned.server, false);
});
