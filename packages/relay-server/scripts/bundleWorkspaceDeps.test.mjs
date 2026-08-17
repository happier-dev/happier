import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function waitForCondition(predicate, label, timeoutMs = 1_000) {
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    const check = () => {
      if (predicate()) {
        clearTimeout(timeout);
        resolvePromise();
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
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

export function bundleWorkspacePackagesWithRuntimeDependencies({ bundles }) {
  bundleWorkspacePackages({ bundles });
  for (const bundle of bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(bundle.srcDir, 'package.json'),
      destPackageDir: bundle.destDir,
    });
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

test('bundleWorkspaceDeps uses the canonical long shared-lock contention budget', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happy-relay-bundle-workspace-deps-lock-budget-'));
  const relayDir = resolve(repoRoot, 'packages', 'relay-server');
  const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
  const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
  let attempt = null;
  const originalNow = Date.now;
  try {
    writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
    mkdirSync(relayDir, { recursive: true });
    mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
    writeJson(resolve(relayDir, 'package.json'), {
      name: '@happier-dev/relay-server',
      private: true,
      bundledDependencies: [],
      dependencies: {},
    });
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
    writeCliCommonWorkspacesStub(cliCommonDir);

    let nowMs = originalNow();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    }), 'utf8');
    Date.now = () => nowMs;

    attempt = bundleWorkspaceDeps({
      repoRoot,
      relayDir,
      ensureWorkspacePackagesBuiltByName: async () => ({ ok: true, built: [], skipped: [] }),
    });
    await waitForCondition(
      () => existsSync(`${lockPath}.priority-claim`),
      'relay workspace-bundle lock contender',
    );

    nowMs += 4 * 60_000 + 1;
    const outcome = await Promise.race([
      attempt.then(
        () => 'fulfilled',
        () => 'rejected',
      ),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise('pending'), 1_100)),
    ]);
    assert.equal(outcome, 'pending');

    Date.now = originalNow;
    unlinkSync(lockPath);
    await attempt;
    attempt = null;
  } finally {
    Date.now = originalNow;
    if (existsSync(lockPath)) unlinkSync(lockPath);
    await attempt?.catch(() => {});
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps admits resolved workspace bundles before copying source-newer dist', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happy-relay-bundle-workspace-deps-owner-admission-'));
  try {
    writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');

    const relayDir = resolve(repoRoot, 'packages', 'relay-server');
    const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
    const releaseRuntimeDir = resolve(repoRoot, 'packages', 'release-runtime');
    mkdirSync(relayDir, { recursive: true });
    mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'src'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });

    writeJson(resolve(relayDir, 'package.json'), {
      name: '@happier-dev/relay-server',
      private: true,
      bundledDependencies: ['@happier-dev/release-runtime'],
      dependencies: { '@happier-dev/release-runtime': '0.0.0' },
    });
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
    writeCliCommonWorkspacesStub(cliCommonDir);
    writeJson(resolve(releaseRuntimeDir, 'package.json'), {
      name: '@happier-dev/release-runtime',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    });
    const sourcePath = resolve(releaseRuntimeDir, 'src', 'index.ts');
    const distPath = resolve(releaseRuntimeDir, 'dist', 'index.js');
    writeFileSync(sourcePath, 'export const generation = "new";\n', 'utf8');
    writeFileSync(distPath, 'export const generation = "old";\n', 'utf8');
    const now = Date.now();
    utimesSync(distPath, new Date(now - 10_000), new Date(now - 10_000));
    utimesSync(sourcePath, new Date(now), new Date(now));

    let admittedPackageNames = null;
    let admissionEnv = null;
    let admissionForce = null;
    await bundleWorkspaceDeps({
      repoRoot,
      relayDir,
      env: { HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: '/parent-stage' },
      ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
        admittedPackageNames = packageNames;
        admissionEnv = options?.env;
        admissionForce = options?.force;
        writeFileSync(distPath, 'export const generation = "new";\n', 'utf8');
        return { ok: true, built: ['@happier-dev/release-runtime'], skipped: [] };
      },
    });

    assert.equal(
      readFileSync(
        resolve(relayDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
        'utf8',
      ),
      'export const generation = "new";\n',
    );
    assert.deepEqual(admittedPackageNames, ['@happier-dev/release-runtime']);
    assert.match(String(admissionEnv?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? ''), /"path"/);
    assert.equal(admissionEnv?.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, undefined);
    assert.equal(admissionForce, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps artifact mode rebuilds newer stale workspace output from current source', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happy-relay-bundle-workspace-deps-artifact-admission-'));
  try {
    writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');

    const relayDir = resolve(repoRoot, 'packages', 'relay-server');
    const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
    const releaseRuntimeDir = resolve(repoRoot, 'packages', 'release-runtime');
    mkdirSync(relayDir, { recursive: true });
    mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'src'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });

    writeJson(resolve(relayDir, 'package.json'), {
      name: '@happier-dev/relay-server',
      private: true,
      bundledDependencies: ['@happier-dev/release-runtime'],
      dependencies: { '@happier-dev/release-runtime': '0.0.0' },
    });
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
    writeCliCommonWorkspacesStub(cliCommonDir);
    writeJson(resolve(releaseRuntimeDir, 'package.json'), {
      name: '@happier-dev/release-runtime',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    });
    const sourcePath = resolve(releaseRuntimeDir, 'src', 'index.ts');
    const distPath = resolve(releaseRuntimeDir, 'dist', 'index.js');
    writeFileSync(sourcePath, 'export const generation = "current";\n', 'utf8');
    writeFileSync(distPath, 'export const generation = "stale";\n', 'utf8');
    const now = Date.now();
    utimesSync(sourcePath, new Date(now), new Date(now));
    utimesSync(distPath, new Date(now + 10_000), new Date(now + 10_000));

    const admissionCalls = [];
    await bundleWorkspaceDeps({
      repoRoot,
      relayDir,
      publicationMode: 'artifact',
      ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
        admissionCalls.push({ packageNames, force: options?.force });
        if (options?.force === true && packageNames.includes('@happier-dev/release-runtime')) {
          writeFileSync(distPath, 'export const generation = "current";\n', 'utf8');
        }
        return { ok: true, built: options?.force === true ? packageNames : [], skipped: [] };
      },
    });

    assert.equal(
      readFileSync(
        resolve(relayDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
        'utf8',
      ),
      'export const generation = "current";\n',
    );
    assert.equal(
      admissionCalls.some(
        ({ packageNames, force }) => (
          packageNames.length === 1
          && packageNames[0] === '@happier-dev/cli-common'
          && force === true
        ),
      ),
      true,
    );
    assert.equal(
      admissionCalls.some(
        ({ packageNames, force }) => (
          packageNames.includes('@happier-dev/release-runtime')
          && force === true
        ),
      ),
      true,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
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
