import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createBundleFixture(prefix = 'happy-stack-bundle-workspace-deps-') {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  const stackDir = resolve(repoRoot, 'apps', 'stack');
  const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
  const releaseRuntimeDir = resolve(repoRoot, 'packages', 'release-runtime');
  writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
  writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
  mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
  mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });
  mkdirSync(stackDir, { recursive: true });

  // bundleWorkspaceDeps also bundles @happier-dev/release-runtime. Keep a minimal, build-like
  // workspace package present so these tests focus on bundling behavior instead of fixture setup.
  writeJson(resolve(releaseRuntimeDir, 'package.json'), {
    name: '@happier-dev/release-runtime',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { postinstall: 'echo should-not-run' },
  });
  writeFileSync(resolve(releaseRuntimeDir, 'dist', 'index.js'), 'export const release = 1;\n', 'utf8');

  return { repoRoot, stackDir, cliCommonDir };
}

test('bundleWorkspaceDeps copies dist + writes a sanitized package.json without install scripts', () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture();
  try {
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');

    bundleWorkspaceDeps({ repoRoot, stackDir });

    const bundledPkgJson = JSON.parse(
      readFileSync(resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'package.json'), 'utf8'),
    );
    assert.equal(bundledPkgJson.scripts, undefined);
    assert.equal(bundledPkgJson.name, '@happier-dev/cli-common');
    assert.equal(bundledPkgJson.private, true);

    const bundledDistPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js');
    assert.ok(existsSync(bundledDistPath), 'dist/index.js should be copied to bundled location');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps throws when cli-common dist/ is missing', () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-no-dist-');
  try {
    rmSync(resolve(cliCommonDir, 'dist'), { recursive: true, force: true });
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      main: './dist/index.js',
    });
    assert.throws(() => bundleWorkspaceDeps({ repoRoot, stackDir }), /Missing dist\/ for @happier-dev\/cli-common/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps throws when cli-common package.json is malformed', () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-bad-json-');
  try {
    writeFileSync(resolve(cliCommonDir, 'package.json'), '{"name":"@happier-dev/cli-common"', 'utf8');
    assert.throws(() => bundleWorkspaceDeps({ repoRoot, stackDir }), SyntaxError);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps vendors external runtime dependency trees for bundled workspace packages', () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-vendor-tree-');
  try {
    const depADir = resolve(repoRoot, 'node_modules', 'dep-a');
    const depBDir = resolve(repoRoot, 'node_modules', 'dep-b');
    mkdirSync(depADir, { recursive: true });
    mkdirSync(depBDir, { recursive: true });

    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      dependencies: {
        'dep-a': '^1.0.0',
      },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');

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

    bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(
      JSON.parse(
        readFileSync(
          resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'node_modules', 'dep-a', 'package.json'),
          'utf8',
        ),
      ).name,
      'dep-a',
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          resolve(
            stackDir,
            'node_modules',
            '@happier-dev',
            'cli-common',
            'node_modules',
            'dep-a',
            'node_modules',
            'dep-b',
            'package.json',
          ),
          'utf8',
        ),
      ).name,
      'dep-b',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
