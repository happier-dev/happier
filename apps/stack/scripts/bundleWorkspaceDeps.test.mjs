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
  const stackPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'apps', 'stack', 'package.json'), 'utf8'));

  const bundled = stackPackageJson.bundledDependencies ?? [];
  const deps = stackPackageJson.dependencies ?? {};

  assert.equal(
    bundled.includes('@happier-dev/connection-supervisor'),
    true,
    'Expected @happier-dev/connection-supervisor to be bundled with @happier-dev/stack',
  );

  for (const name of bundled) {
    assert.equal(Boolean(deps[name]), true, `Expected ${name} to be declared in dependencies`);
  }
});

function createBundleFixture(prefix = 'happy-stack-bundle-workspace-deps-') {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  const stackDir = resolve(repoRoot, 'apps', 'stack');
  const agentsDir = resolve(repoRoot, 'packages', 'agents');
  const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
  const connectionSupervisorDir = resolve(repoRoot, 'packages', 'connection-supervisor');
  const protocolDir = resolve(repoRoot, 'packages', 'protocol');
  const releaseRuntimeDir = resolve(repoRoot, 'packages', 'release-runtime');
  writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
  writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
  mkdirSync(resolve(agentsDir, 'dist'), { recursive: true });
  mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
  mkdirSync(resolve(connectionSupervisorDir, 'dist'), { recursive: true });
  mkdirSync(resolve(protocolDir, 'dist'), { recursive: true });
  mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });
  mkdirSync(stackDir, { recursive: true });
  writeJson(resolve(stackDir, 'package.json'), {
    name: '@happier-dev/stack',
    private: true,
    bundledDependencies: [
      '@happier-dev/agents',
      '@happier-dev/cli-common',
      '@happier-dev/connection-supervisor',
      '@happier-dev/protocol',
      '@happier-dev/release-runtime',
    ],
    dependencies: {
      '@happier-dev/agents': '0.0.0',
      '@happier-dev/cli-common': '0.0.0',
      '@happier-dev/connection-supervisor': '0.0.0',
      '@happier-dev/protocol': '0.0.0',
      '@happier-dev/release-runtime': '0.0.0',
    },
  });

  // bundleWorkspaceDeps also bundles @happier-dev/release-runtime. Keep a minimal, build-like
  // workspace package present so these tests focus on bundling behavior instead of fixture setup.
  writeJson(resolve(cliCommonDir, 'package.json'), {
    name: '@happier-dev/cli-common',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    dependencies: {
      '@happier-dev/agents': '0.0.0',
    },
  });
  writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const common = 1;\n', 'utf8');
  writeCliCommonWorkspacesStub(cliCommonDir);

  writeJson(resolve(agentsDir, 'package.json'), {
    name: '@happier-dev/agents',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { postinstall: 'echo should-not-run' },
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  writeFileSync(resolve(agentsDir, 'dist', 'index.js'), 'export const agents = 1;\n', 'utf8');

  writeJson(resolve(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { postinstall: 'echo should-not-run' },
  });
  writeFileSync(resolve(protocolDir, 'dist', 'index.js'), 'export const protocol = 1;\n', 'utf8');

  writeJson(resolve(connectionSupervisorDir, 'package.json'), {
    name: '@happier-dev/connection-supervisor',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { postinstall: 'echo should-not-run' },
  });
  writeFileSync(resolve(connectionSupervisorDir, 'dist', 'index.js'), 'export const supervisor = 1;\n', 'utf8');

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

  return { repoRoot, stackDir, agentsDir, cliCommonDir, connectionSupervisorDir, protocolDir };
}

test('bundleWorkspaceDeps copies dist + writes a sanitized package.json without install scripts', async () => {
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

    await bundleWorkspaceDeps({ repoRoot, stackDir });

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

test('bundleWorkspaceDeps bundles internal deps required by the stack host package closure', async () => {
  const { repoRoot, stackDir } = createBundleFixture('happy-stack-bundle-workspace-deps-internal-closure-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.ok(existsSync(resolve(stackDir, 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js')));
    assert.ok(existsSync(resolve(stackDir, 'node_modules', '@happier-dev', 'connection-supervisor', 'dist', 'index.js')));
    assert.ok(existsSync(resolve(stackDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps throws when cli-common dist/ is missing', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-no-dist-');
  try {
    rmSync(resolve(cliCommonDir, 'dist'), { recursive: true, force: true });
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      main: './dist/index.js',
    });
    await assert.rejects(bundleWorkspaceDeps({ repoRoot, stackDir }), /Missing dist\/ for @happier-dev\/cli-common/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps throws when cli-common package.json is malformed', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-bad-json-');
  try {
    writeFileSync(resolve(cliCommonDir, 'package.json'), '{"name":"@happier-dev/cli-common"', 'utf8');
    await assert.rejects(bundleWorkspaceDeps({ repoRoot, stackDir }), SyntaxError);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps vendors external runtime dependency trees for bundled workspace packages', async () => {
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

    await bundleWorkspaceDeps({ repoRoot, stackDir });

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
