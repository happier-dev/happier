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

function writeCliCommonWorkspacesStub(cliCommonDir) {
  const workspacesDir = resolve(cliCommonDir, 'dist', 'workspaces');
  mkdirSync(workspacesDir, { recursive: true });
  writeFileSync(resolve(workspacesDir, 'index.js'), `
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function readJson(path) {
  return JSON.parse(String(readFileSync(path, 'utf8')));
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export function resolveWorkspaceBundlesFromPackageJson({ repoRoot, hostPackageDir }) {
  const pkg = readJson(resolve(hostPackageDir, 'package.json'));
  const bundled = Array.isArray(pkg.bundledDependencies) ? pkg.bundledDependencies : [];
  const bundles = [];
  for (const name of bundled) {
    if (typeof name !== 'string' || !name.startsWith('@happier-dev/')) continue;
    const short = name.slice('@happier-dev/'.length);
    bundles.push({
      name,
      srcDir: resolve(repoRoot, 'packages', short),
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', short),
    });
  }
  return bundles;
}

export function bundleWorkspacePackages({ bundles }) {
  for (const b of bundles) {
    const distSrc = resolve(b.srcDir, 'dist');
    if (!existsSync(distSrc)) {
      throw new Error(\`Missing dist/ for \${b.name}\`);
    }

    const pkgJsonPath = resolve(b.srcDir, 'package.json');
    const pkgJson = readJson(pkgJsonPath);
    delete pkgJson.scripts;
    pkgJson.private = true;

    mkdirSync(b.destDir, { recursive: true });
    cpSync(distSrc, resolve(b.destDir, 'dist'), { recursive: true });
    writeFileSync(resolve(b.destDir, 'package.json'), \`\${JSON.stringify(pkgJson, null, 2)}\\n\`, 'utf8');
  }
}

function vendorOne({ repoRoot, name, destNodeModulesDir, seen }) {
  const key = \`\${destNodeModulesDir}:\${name}\`;
  if (seen.has(key)) return;
  seen.add(key);

  const srcDir = resolve(repoRoot, 'node_modules', name);
  const pkgPath = resolve(srcDir, 'package.json');
  if (!existsSync(pkgPath)) return;

  const destDir = resolve(destNodeModulesDir, name);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });

  const pkg = readJson(pkgPath);
  const deps = pkg && typeof pkg === 'object' ? pkg.dependencies : null;
  if (!deps || typeof deps !== 'object') return;
  for (const depName of Object.keys(deps)) {
    vendorOne({ repoRoot, name: depName, destNodeModulesDir: resolve(destDir, 'node_modules'), seen });
  }
}

export function vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath, destPackageDir }) {
  const repoRoot = findRepoRoot(dirname(dirname(srcPackageJsonPath)));
  const pkg = readJson(srcPackageJsonPath);
  const deps = pkg && typeof pkg === 'object' ? pkg.dependencies : null;
  if (!deps || typeof deps !== 'object') return;

  const destNodeModulesDir = resolve(destPackageDir, 'node_modules');
  mkdirSync(destNodeModulesDir, { recursive: true });
  const seen = new Set();
  for (const name of Object.keys(deps)) {
    if (name.startsWith('@happier-dev/')) continue;
    vendorOne({ repoRoot, name, destNodeModulesDir, seen });
  }
}
`, 'utf8');
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

test('bundleWorkspaceDeps vendors external runtime dependency trees for bundled workspace packages', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happy-relay-bundle-workspace-deps-vendor-tree-'));
  try {
    writeJson(resolve(tempRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(tempRoot, 'yarn.lock'), '# lock\n', 'utf8');

    const relayDir = resolve(tempRoot, 'packages', 'relay-server');
    const cliCommonDir = resolve(tempRoot, 'packages', 'cli-common');
    const releaseRuntimeDir = resolve(tempRoot, 'packages', 'release-runtime');

    const depADir = resolve(tempRoot, 'node_modules', 'dep-a');
    const depBDir = resolve(tempRoot, 'node_modules', 'dep-b');

    mkdirSync(resolve(relayDir, 'node_modules', '@happier-dev', 'release-runtime'), { recursive: true });
    writeJson(resolve(relayDir, 'package.json'), {
      name: '@happier-dev/relay-server',
      private: true,
      bundledDependencies: ['@happier-dev/release-runtime'],
      dependencies: {
        '@happier-dev/release-runtime': '0.0.0',
      },
    });
    mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });
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
        '@happier-dev/release-runtime': '0.0.0',
      },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const common = 1;\n', 'utf8');
    writeCliCommonWorkspacesStub(cliCommonDir);

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

    await bundleWorkspaceDeps({ repoRoot: tempRoot, relayDir });

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
