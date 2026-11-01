import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('bundleWorkspaceDeps refreshes package-root imports targets through the real workspace copier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-import-target-refresh-'));
  try {
    const stackDir = resolve(root, 'apps/stack');
    const commonDir = resolve(root, 'packages/cli-common');
    const sourceDir = resolve(root, 'packages/fixture');
    const destinationDir = resolve(stackDir, 'node_modules/@happier-dev/fixture');
    mkdirSync(stackDir, { recursive: true });
    mkdirSync(resolve(commonDir, 'dist/workspaces'), { recursive: true });
    mkdirSync(resolve(sourceDir, 'dist'), { recursive: true });
    mkdirSync(resolve(sourceDir, 'runtime'), { recursive: true });
    writeJson(resolve(root, 'package.json'), { name: 'fixture-root', private: true });
    writeFileSync(resolve(root, 'yarn.lock'), '');
    writeJson(resolve(stackDir, 'package.json'), { bundledDependencies: ['@happier-dev/fixture'] });
    writeJson(resolve(commonDir, 'package.json'), { name: '@happier-dev/cli-common', type: 'module' });
    // Exercise the real current source owner, not the older internal copier stub.
    writeFileSync(resolve(commonDir, 'dist/workspaces/index.js'), `export * from ${JSON.stringify(new URL('../../../packages/cli-common/src/workspaces/index.ts', import.meta.url).href)};\n`);
    writeJson(resolve(sourceDir, 'package.json'), {
      name: '@happier-dev/fixture', version: '0.0.0', type: 'module',
      exports: { '.': './dist/connect.js' },
      imports: { '#http': { node: './runtime/node.js', default: './dist/fetch.js' }, '#fs': 'fs', '#disabled': null },
    });
    writeFileSync(resolve(sourceDir, 'dist/connect.js'), 'export { transport } from "#http";\n');
    writeFileSync(resolve(sourceDir, 'dist/fetch.js'), 'export const transport = "fetch";\n');
    const target = resolve(sourceDir, 'runtime/node.js');
    writeFileSync(target, 'export const transport = "first";\n');
    writeFileSync(resolve(sourceDir, 'fs'), 'not an imports file target\n');
    // Compiler execution is an OS boundary; these fixture outputs are already
    // present and forward to real source, so no compiler or repository publisher runs.
    const options = { repoRoot: root, stackDir, ensureWorkspacePackagesBuiltByName: async () => {} };
    await bundleWorkspaceDeps(options);
    const manifest = JSON.parse(readFileSync(resolve(stackDir, 'node_modules/@happier-dev/.workspace-bundle-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.bundles[0].expectedRootFiles.map(({ relativePath }) => relativePath), ['runtime/node.js']);
    writeFileSync(target, 'export const transport = "updated";\n');
    await bundleWorkspaceDeps(options);
    assert.equal(readFileSync(resolve(destinationDir, 'runtime/node.js'), 'utf8'), 'export const transport = "updated";\n');
    const result = execFileSync(process.execPath, ['--input-type=module', '-e',
      `console.log((await import(${JSON.stringify(pathToFileURL(resolve(destinationDir, 'dist/connect.js')).href)})).transport);`,
    ], { encoding: 'utf8' }).trim();
    assert.equal(result, 'updated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

function collectPackageJsonRelativeFileTargets(value, result = new Set()) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('./') && !trimmed.includes('*')) result.add(trimmed.slice(2));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectPackageJsonRelativeFileTargets(nested, result);
  }
  return result;
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
    const srcDir = resolve(repoRoot, 'packages', short);
    const workspacePackageJson = readJson(resolve(srcDir, 'package.json'));
    bundles.push({
      packageName: name,
      srcDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', short),
      includeFiles: Array.isArray(workspacePackageJson.happierWorkspaceBundleFiles)
        ? workspacePackageJson.happierWorkspaceBundleFiles
        : [],
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
    for (const relativePath of collectPackageJsonRelativeFileTargets(pkgJson.exports)) {
      const sourcePath = resolve(b.srcDir, relativePath);
      if (existsSync(sourcePath) && !relativePath.startsWith('dist/')) {
        cpSync(sourcePath, resolve(b.destDir, relativePath));
      }
    }
    for (const relativePath of b.includeFiles ?? []) {
      const sourcePath = resolve(b.srcDir, relativePath);
      if (existsSync(sourcePath)) {
        mkdirSync(dirname(resolve(b.destDir, relativePath)), { recursive: true });
        cpSync(sourcePath, resolve(b.destDir, relativePath));
      }
    }
    writeFileSync(resolve(b.destDir, 'package.json'), \`\${JSON.stringify(pkgJson, null, 2)}\\n\`, 'utf8');
  }
}

function resolveInstalledPackageDir({ name, resolveFromPackageJsonPath }) {
  let dir = dirname(resolveFromPackageJsonPath);
  for (let i = 0; i < 20; i += 1) {
    const candidate = resolve(dir, 'node_modules', name);
    const pkgPath = resolve(candidate, 'package.json');
    if (existsSync(pkgPath)) {
      return { packageDir: candidate, packageJsonPath: pkgPath };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function vendorOne({ name, resolveFromPackageJsonPath, destNodeModulesDir, seen }) {
  const key = \`\${destNodeModulesDir}:\${name}\`;
  if (seen.has(key)) return;
  seen.add(key);

  const resolved = resolveInstalledPackageDir({ name, resolveFromPackageJsonPath });
  if (!resolved) return;
  const srcDir = resolved.packageDir;
  const pkgPath = resolved.packageJsonPath;

  const destDir = resolve(destNodeModulesDir, name);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });

  const pkg = readJson(pkgPath);
  const deps = pkg && typeof pkg === 'object' ? pkg.dependencies : null;
  if (!deps || typeof deps !== 'object') return;
  for (const depName of Object.keys(deps)) {
    vendorOne({
      name: depName,
      resolveFromPackageJsonPath: pkgPath,
      destNodeModulesDir: resolve(destDir, 'node_modules'),
      seen,
    });
  }
}

export function vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath, destPackageDir }) {
  const pkg = readJson(srcPackageJsonPath);
  const deps = pkg && typeof pkg === 'object' ? pkg.dependencies : null;
  if (!deps || typeof deps !== 'object') return;

  const destNodeModulesDir = resolve(destPackageDir, 'node_modules');
  mkdirSync(destNodeModulesDir, { recursive: true });
  const seen = new Set();
  for (const name of Object.keys(deps)) {
    if (name.startsWith('@happier-dev/')) continue;
    vendorOne({ name, resolveFromPackageJsonPath: srcPackageJsonPath, destNodeModulesDir, seen });
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
  writeFileSync(resolve(cliCommonDir, 'dist', 'index.d.ts'), 'export declare const common: number;\n', 'utf8');
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
  writeFileSync(resolve(agentsDir, 'dist', 'index.d.ts'), 'export declare const agents: number;\n', 'utf8');

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
  writeFileSync(resolve(protocolDir, 'dist', 'index.d.ts'), 'export declare const protocol: number;\n', 'utf8');

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
  writeFileSync(resolve(connectionSupervisorDir, 'dist', 'index.d.ts'), 'export declare const supervisor: number;\n', 'utf8');

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
  writeFileSync(resolve(releaseRuntimeDir, 'dist', 'index.d.ts'), 'export declare const release: number;\n', 'utf8');

  return {
    repoRoot,
    stackDir,
    agentsDir,
    cliCommonDir,
    connectionSupervisorDir,
    protocolDir,
    releaseRuntimeDir,
  };
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
      happierWorkspaceBundleFiles: ['native/windows/bin/windows-x64/happier-service-launcher.exe'],
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');
    mkdirSync(resolve(cliCommonDir, 'native', 'windows', 'bin', 'windows-x64'), { recursive: true });
    writeFileSync(resolve(cliCommonDir, 'native', 'windows', 'bin', 'windows-x64', 'happier-service-launcher.exe'), 'synthetic launcher bytes');

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const bundledPkgJson = JSON.parse(
      readFileSync(resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'package.json'), 'utf8'),
    );
    assert.equal(bundledPkgJson.scripts, undefined);
    assert.equal(bundledPkgJson.name, '@happier-dev/cli-common');
    assert.equal(bundledPkgJson.private, true);

    const bundledDistPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js');
    assert.ok(existsSync(bundledDistPath), 'dist/index.js should be copied to bundled location');
    assert.ok(existsSync(resolve(
      stackDir,
      'node_modules',
      '@happier-dev',
      'cli-common',
      'native',
      'windows',
      'bin',
      'windows-x64',
      'happier-service-launcher.exe',
    )), 'Windows service launcher should be copied to bundled location');
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

test('bundleWorkspaceDeps records bundled workspace package names in the freshness manifest', async () => {
  const { repoRoot, stackDir } = createBundleFixture('happy-stack-bundle-workspace-deps-manifest-package-names-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifest = JSON.parse(
      readFileSync(resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json'), 'utf8'),
    );

    assert.deepEqual(
      manifest.bundles.map((bundle) => bundle.packageName),
      [
        '@happier-dev/agents',
        '@happier-dev/cli-common',
        '@happier-dev/connection-supervisor',
        '@happier-dev/protocol',
        '@happier-dev/release-runtime',
      ],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps admits resolved workspace bundles before copying source-newer dist', async () => {
  const {
    repoRoot,
    stackDir,
    releaseRuntimeDir,
  } = createBundleFixture('happy-stack-bundle-workspace-deps-owner-admission-');
  try {
    const sourcePath = resolve(releaseRuntimeDir, 'src', 'index.ts');
    const distPath = resolve(releaseRuntimeDir, 'dist', 'index.js');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'export const generation = "new";\n', 'utf8');
    writeFileSync(distPath, 'export const generation = "old";\n', 'utf8');
    const now = Date.now();
    utimesSync(distPath, new Date(now - 10_000), new Date(now - 10_000));
    utimesSync(sourcePath, new Date(now), new Date(now));

    let admittedPackageNames = null;
    let admissionEnv = null;
    await bundleWorkspaceDeps({
      repoRoot,
      stackDir,
      env: { HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: '/parent-stage' },
      ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
        admittedPackageNames = packageNames;
        admissionEnv = options?.env;
        writeFileSync(distPath, 'export const generation = "new";\n', 'utf8');
        return { ok: true, built: ['@happier-dev/release-runtime'], skipped: [] };
      },
    });

    assert.equal(
      readFileSync(
        resolve(stackDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
        'utf8',
      ),
      'export const generation = "new";\n',
    );
    assert.deepEqual(admittedPackageNames, [
      '@happier-dev/agents',
      '@happier-dev/cli-common',
      '@happier-dev/connection-supervisor',
      '@happier-dev/protocol',
      '@happier-dev/release-runtime',
    ]);
    assert.match(String(admissionEnv?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? ''), /"path"/);
    assert.equal(admissionEnv?.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, undefined);
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

test('bundleWorkspaceDeps stays fresh while a declared bundle file is not built, and refreshes once it is', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-optional-include-');
  try {
    const launcherRelativePath = 'native/windows/bin/windows-x64/happier-service-launcher.exe';
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
      happierWorkspaceBundleFiles: [launcherRelativePath],
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');

    await bundleWorkspaceDeps({ repoRoot, stackDir });
    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const firstMtimeMs = statSync(manifestPath).mtimeMs;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await bundleWorkspaceDeps({ repoRoot, stackDir });
    assert.equal(statSync(manifestPath).mtimeMs, firstMtimeMs, 'an unbuilt optional bundle file must not force a rebundle');

    mkdirSync(resolve(cliCommonDir, 'native', 'windows', 'bin', 'windows-x64'), { recursive: true });
    writeFileSync(resolve(cliCommonDir, launcherRelativePath), 'built launcher');
    await bundleWorkspaceDeps({ repoRoot, stackDir });
    assert.equal(
      readFileSync(resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', launcherRelativePath), 'utf8'),
      'built launcher',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when a vendored runtime dependency is incomplete', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-runtime-dep-');
  try {
    const depADir = resolve(repoRoot, 'node_modules', 'dep-a');
    mkdirSync(depADir, { recursive: true });

    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: {
        'dep-a': '^1.0.0',
      },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');

    writeJson(resolve(depADir, 'package.json'), {
      name: 'dep-a',
      version: '1.0.0',
      main: 'index.js',
    });
    writeFileSync(resolve(depADir, 'index.js'), 'module.exports = { a: true };\n', 'utf8');

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const vendoredEntryPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'node_modules', 'dep-a', 'index.js');
    const firstMtimeMs = statSync(manifestPath).mtimeMs;

    unlinkSync(vendoredEntryPath);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(vendoredEntryPath), true);
    assert.ok(statSync(manifestPath).mtimeMs > firstMtimeMs);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when a package-local runtime dependency is incomplete', async () => {
  const { repoRoot, stackDir, agentsDir } = createBundleFixture(
    'happy-stack-bundle-workspace-deps-refresh-package-local-runtime-dep-',
  );
  try {
    const depLocalDir = resolve(agentsDir, 'node_modules', 'dep-local');
    mkdirSync(depLocalDir, { recursive: true });

    writeJson(resolve(agentsDir, 'package.json'), {
      name: '@happier-dev/agents',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: {
        '@happier-dev/protocol': '0.0.0',
        'dep-local': '^1.0.0',
      },
    });
    writeFileSync(resolve(agentsDir, 'dist', 'index.js'), "import 'dep-local';\nexport const agents = 1;\n", 'utf8');

    writeJson(resolve(depLocalDir, 'package.json'), {
      name: 'dep-local',
      version: '1.0.0',
      main: 'index.js',
    });
    writeFileSync(resolve(depLocalDir, 'index.js'), 'module.exports = { local: true };\n', 'utf8');

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const vendoredEntryPath = resolve(
      stackDir,
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'dep-local',
      'index.js',
    );
    const firstMtimeMs = statSync(manifestPath).mtimeMs;

    unlinkSync(vendoredEntryPath);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(vendoredEntryPath), true);
    assert.ok(statSync(manifestPath).mtimeMs > firstMtimeMs);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when a vendored runtime dependency is missing a non-exported runtime file', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-runtime-dep-internal-file-');
  try {
    const depADir = resolve(repoRoot, 'node_modules', 'dep-a');
    mkdirSync(resolve(depADir, 'lib'), { recursive: true });

    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: {
        'dep-a': '^1.0.0',
      },
    });
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');

    writeJson(resolve(depADir, 'package.json'), {
      name: 'dep-a',
      version: '1.0.0',
      main: 'index.js',
      exports: { '.': './index.js' },
    });
    writeFileSync(resolve(depADir, 'index.js'), "module.exports = require('./lib/internal.js');\n", 'utf8');
    writeFileSync(resolve(depADir, 'lib', 'internal.js'), 'module.exports = { ok: true };\n', 'utf8');

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const vendoredInternalPath = resolve(
      stackDir,
      'node_modules',
      '@happier-dev',
      'cli-common',
      'node_modules',
      'dep-a',
      'lib',
      'internal.js',
    );
    const firstMtimeMs = statSync(manifestPath).mtimeMs;

    unlinkSync(vendoredInternalPath);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(vendoredInternalPath), true);
    assert.ok(statSync(manifestPath).mtimeMs > firstMtimeMs);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps skips rebundling when the existing bundle is already fresh and complete', async () => {
  const { repoRoot, stackDir } = createBundleFixture('happy-stack-bundle-workspace-deps-skip-fresh-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const firstMtimeMs = statSync(manifestPath).mtimeMs;

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(statSync(manifestPath).mtimeMs, firstMtimeMs);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when the source dist changes', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-source-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const bundledCliCommonIndexPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js');
    const firstMtimeMs = statSync(manifestPath).mtimeMs;

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 42;\n', 'utf8');

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.match(readFileSync(bundledCliCommonIndexPath, 'utf8'), /42/);
    assert.ok(statSync(manifestPath).mtimeMs > firstMtimeMs);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when an exported package-root file changes', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-root-export-');
  try {
    const packageJsonPath = resolve(cliCommonDir, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    packageJson.exports['./workspaceBundleLock'] = { default: './workspaceBundleLock.mjs' };
    writeJson(packageJsonPath, packageJson);
    const sourcePath = resolve(cliCommonDir, 'workspaceBundleLock.mjs');
    const bundledPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'workspaceBundleLock.mjs');
    const fixedSourceTime = new Date('2020-01-02T03:04:05.000Z');
    writeFileSync(sourcePath, 'export const lockVersion = 1;\n', 'utf8');
    utimesSync(sourcePath, fixedSourceTime, fixedSourceTime);

    await bundleWorkspaceDeps({ repoRoot, stackDir });
    assert.match(readFileSync(bundledPath, 'utf8'), /lockVersion = 1/);

    const originalSourceStat = statSync(sourcePath);
    writeFileSync(sourcePath, 'export const lockVersion = 2;\n', 'utf8');
    utimesSync(sourcePath, fixedSourceTime, fixedSourceTime);
    const rewrittenSourceStat = statSync(sourcePath);
    assert.equal(rewrittenSourceStat.size, originalSourceStat.size);
    assert.equal(Math.trunc(rewrittenSourceStat.mtimeMs), Math.trunc(originalSourceStat.mtimeMs));
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.match(readFileSync(bundledPath, 'utf8'), /lockVersion = 2/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when the existing bundled dist is incomplete', async () => {
  const { repoRoot, stackDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-incomplete-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const bundledCliCommonIndexPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js');
    const firstMtimeMs = statSync(manifestPath).mtimeMs;

    unlinkSync(bundledCliCommonIndexPath);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(bundledCliCommonIndexPath), true);
    assert.ok(statSync(manifestPath).mtimeMs > firstMtimeMs);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when a bundled workspace is missing a non-exported dist runtime file', async () => {
  const { repoRoot, stackDir, agentsDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-internal-runtime-file-');
  try {
    mkdirSync(resolve(agentsDir, 'dist', 'providers'), { recursive: true });
    writeFileSync(
      resolve(agentsDir, 'dist', 'manifest.js'),
      "import './providers/providerCliRuntime.js';\nexport const manifest = true;\n",
      'utf8',
    );
    writeFileSync(
      resolve(agentsDir, 'dist', 'providers', 'providerCliRuntime.js'),
      'export const providerCliRuntime = true;\n',
      'utf8',
    );

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const manifestPath = resolve(stackDir, 'node_modules', '@happier-dev', '.workspace-bundle-manifest.json');
    const bundledRuntimeFilePath = resolve(
      stackDir,
      'node_modules',
      '@happier-dev',
      'agents',
      'dist',
      'providers',
      'providerCliRuntime.js',
    );
    const firstMtimeMs = statSync(manifestPath).mtimeMs;

    unlinkSync(bundledRuntimeFilePath);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(bundledRuntimeFilePath), true);
    assert.ok(statSync(manifestPath).mtimeMs > firstMtimeMs);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
