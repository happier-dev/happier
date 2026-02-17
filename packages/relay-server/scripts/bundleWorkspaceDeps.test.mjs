import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('bundledDependencies are declared in dependencies', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const relayPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'packages', 'relay-server', 'package.json'), 'utf8'));

  const bundled = relayPackageJson.bundledDependencies ?? [];
  const deps = relayPackageJson.dependencies ?? {};

  for (const name of bundled) {
    assert.equal(Boolean(deps[name]), true, `Expected ${name} to be declared in dependencies`);
  }
});

test('bundleWorkspaceDeps vendors external runtime dependency trees for bundled workspace packages', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happy-relay-bundle-workspace-deps-vendor-tree-'));
  try {
    writeJson(resolve(tempRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(tempRoot, 'yarn.lock'), '# lock\n', 'utf8');

    const relayDir = resolve(tempRoot, 'packages', 'relay-server');
    const releaseRuntimeDir = resolve(tempRoot, 'packages', 'release-runtime');

    const depADir = resolve(tempRoot, 'node_modules', 'dep-a');
    const depBDir = resolve(tempRoot, 'node_modules', 'dep-b');

    mkdirSync(resolve(relayDir, 'node_modules', '@happier-dev', 'release-runtime'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });
    mkdirSync(depADir, { recursive: true });
    mkdirSync(depBDir, { recursive: true });

    writeJson(resolve(releaseRuntimeDir, 'package.json'), {
      name: '@happier-dev/release-runtime',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      dependencies: {
        'dep-a': '^1.0.0',
      },
    });
    writeFileSync(resolve(releaseRuntimeDir, 'dist', 'index.js'), 'export const release = 1;\n', 'utf8');

    writeJson(resolve(depADir, 'package.json'), {
      name: 'dep-a',
      version: '1.0.0',
      main: 'index.js',
      dependencies: {
        'dep-b': '^1.0.0',
      },
    });
    writeFileSync(resolve(depADir, 'index.js'), 'module.exports = { a: true };\n', 'utf8');

    writeJson(resolve(depBDir, 'package.json'), { name: 'dep-b', version: '1.0.0', main: 'index.js' });
    writeFileSync(resolve(depBDir, 'index.js'), 'module.exports = { b: true };\n', 'utf8');

    bundleWorkspaceDeps({ repoRoot: tempRoot, relayDir });

    const bundledRuntimeDir = resolve(relayDir, 'node_modules', '@happier-dev', 'release-runtime');
    assert.equal(existsSync(resolve(bundledRuntimeDir, 'node_modules', 'dep-a', 'package.json')), true);
    assert.equal(
      existsSync(resolve(bundledRuntimeDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'package.json')),
      true,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
