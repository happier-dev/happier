import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';
import { ensureWorkspacePackagesBuiltByName } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveWorkspaceBundleLockPath, withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv } from './testkit/core/native_admission_fixture.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

for (const heldProducer of ['cli-common', 'fixture']) test(`Stack bundle prepares a foreign-held producer before taking its publication lease (${heldProducer})`, { timeout: 15000 }, async t => {
  // This fixture is an independent publisher, not the admitted test runner.
  // The real lock/admission owner still enforces any lease it acquires below.
  const previousWaitPolicy = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED;
  delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED;
  t.after(() => {
    if (previousWaitPolicy === undefined) delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED;
    else process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED = previousWaitPolicy;
  });
  const fixture = await createTempFixture(t, { prefix: 'hstack-bundle-producer-order-' });
  const root = fixture.root;
  for (const name of ['ui', 'cli', 'server', 'stack']) {
    mkdirSync(fixture.path('apps', name), { recursive: true });
    writeJson(fixture.path('apps', name, 'package.json'), {
      name: `@fixture/${name}`,
      ...(name === 'stack' ? { bundledDependencies: ['@happier-dev/fixture'] } : {}),
    });
  }
  writeJson(fixture.path('package.json'), { private: true });
  writeFileSync(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  for (const name of ['cli-common', 'fixture']) {
    mkdirSync(fixture.path('packages', name), { recursive: true });
    writeJson(fixture.path('packages', name, 'package.json'), {
      name: `@happier-dev/${name}`, type: 'module', main: './dist/index.js',
      scripts: { build: 'node build.mjs' },
    });
  }
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  // Only compiler execution is replaced. Graph traversal, admission, output
  // publication, the helper loader and the final copier all remain real.
  const prepare = (repo, names, options) => ensureWorkspacePackagesBuiltByName(repo, names, {
    ...options, signal: t.signal, workspaceBuildBoundary: {
      prepareEnv: async (_directory, value) => value,
      runPackageBuild: async (directory, { env: buildEnv }) => {
        const output = buildEnv.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, 'index.js'), 'export const ready = true;\n');
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (manifest.name === '@happier-dev/cli-common') {
          mkdirSync(join(output, 'workspaces'), { recursive: true });
          writeFileSync(join(output, 'workspaces/index.js'), `export * from ${JSON.stringify(new URL('../../../packages/cli-common/src/workspaces/index.ts', import.meta.url).href)};\n`);
        }
      },
    },
  });
  const producerDir = fixture.path('packages', heldProducer);
  const producerLock = resolveWorkspacePackageBuildLockPath(producerDir,
    JSON.parse(readFileSync(join(producerDir, 'package.json'), 'utf8')));
  let notifyWait;
  const waiting = new Promise(resolve => { notifyWait = resolve; });
  const stderrWrite = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...args) => {
    if (/waiting for|Workspace publication lease is busy/.test(String(chunk))) notifyWait();
    return stderrWrite(chunk, ...args);
  });
  let publication;
  await withWorkspaceBundleLock(async () => {
    publication = bundleWorkspaceDeps({ repoRoot: root, stackDir: fixture.path('apps', 'stack'), env,
      ensureWorkspacePackagesBuiltByName: prepare });
    await Promise.race([waiting, publication.then(() => assert.fail('published while producer was held'))]);
    assert.equal(existsSync(resolveWorkspaceBundleLockPath(root)), false,
      'a producer wait must not retain the Stack publication lease');
  }, { lockPath: producerLock, signal: t.signal });
  await publication;
  assert.equal(readFileSync(fixture.path('apps/stack/node_modules/@happier-dev/fixture/dist/index.js'), 'utf8'),
    'export const ready = true;\n');
});

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
    writeFileSync(resolve(root, 'pnpm-lock.yaml'), '');
    writeFileSync(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
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
    assert.equal(existsSync(resolve(destinationDir, 'runtime/node.js')), true);
    assert.equal(existsSync(resolve(destinationDir, 'fs')), false);
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

function writeCliCommonWorkspacesFixture(cliCommonDir) {
  const workspacesDir = resolve(cliCommonDir, 'dist', 'workspaces');
  mkdirSync(workspacesDir, { recursive: true });
  // The build boundary forwards to the real graph and publisher; internal
  // normalization, file selection, vendoring and mounted publication stay real.
  writeFileSync(resolve(workspacesDir, 'index.js'),
    `export * from ${JSON.stringify(new URL('../../../packages/cli-common/src/workspaces/index.ts', import.meta.url).href)};\n`);
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
  writeFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), '# lock\n', 'utf8');
  writeFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
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
  writeCliCommonWorkspacesFixture(cliCommonDir);

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
    let admissionForce = null;
    await bundleWorkspaceDeps({
      repoRoot,
      stackDir,
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
        resolve(stackDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
        'utf8',
      ),
      'export const generation = "new";\n',
    );
    assert.deepEqual([...admittedPackageNames].sort(), [
      '@happier-dev/agents',
      '@happier-dev/cli-common',
      '@happier-dev/connection-supervisor',
      '@happier-dev/protocol',
      '@happier-dev/release-runtime',
    ]);
    assert.equal(admissionEnv?.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, undefined);
    assert.equal(admissionForce, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps admits a stale-present cli-common helper before its first import', async () => {
  const {
    repoRoot,
    stackDir,
    cliCommonDir,
  } = createBundleFixture('happy-stack-bundle-workspace-deps-cli-common-admission-');
  try {
    const workspacesModulePath = resolve(cliCommonDir, 'dist', 'workspaces', 'index.js');
    writeFileSync(
      workspacesModulePath,
      [
        "import { readFileSync } from 'node:fs';",
        "import { resolve } from 'node:path';",
        'export function resolveWorkspaceBundlesFromPackageJson({ repoRoot, hostPackageDir }) {',
        "  const host = JSON.parse(readFileSync(resolve(hostPackageDir, 'package.json'), 'utf8'));",
        '  return (host.bundledDependencies ?? []).map((name) => ({',
        '    packageName: name,',
        "    srcDir: resolve(repoRoot, 'packages', name.slice('@happier-dev/'.length)),",
        "    destDir: resolve(hostPackageDir, 'node_modules', ...name.split('/')),",
        '  }));',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    let cliCommonAdmissionCount = 0;
    await bundleWorkspaceDeps({
      repoRoot,
      stackDir,
      ensureWorkspacePackagesBuiltByName: async (_root, packageNames) => {
        if (packageNames.length === 1 && packageNames[0] === '@happier-dev/cli-common') {
          cliCommonAdmissionCount += 1;
          writeCliCommonWorkspacesFixture(cliCommonDir);
        }
        return { ok: true, built: packageNames, skipped: [] };
      },
    });

    assert.equal(cliCommonAdmissionCount >= 1, true);
    assert.equal(
      existsSync(resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js')),
      true,
    );
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
    await assert.rejects(
      bundleWorkspaceDeps({ repoRoot, stackDir }),
      /Missing cli-common workspaces build helpers/,
    );
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

    const vendoredEntryPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'node_modules', 'dep-a', 'index.js');

    const expected = readFileSync(vendoredEntryPath, 'utf8');
    const before = statSync(vendoredEntryPath);
    writeFileSync(vendoredEntryPath, expected.replace('true', 'null'));
    utimesSync(vendoredEntryPath, before.atime, before.mtime);
    await bundleWorkspaceDeps({ repoRoot, stackDir });
    assert.equal(readFileSync(vendoredEntryPath, 'utf8'), expected, 'existing vendor corruption must be repaired');

    unlinkSync(vendoredEntryPath);

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(vendoredEntryPath), true);
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

    unlinkSync(vendoredInternalPath);

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(vendoredInternalPath), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps skips rebundling when the existing bundle is already fresh and complete', async (t) => {
  const { repoRoot, stackDir } = createBundleFixture('happy-stack-bundle-workspace-deps-skip-fresh-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const counts = { copies: 0, writes: 0, bodyReads: 0 };
    for (const name of ['copyFileSync', 'writeFileSync', 'renameSync', 'readFileSync']) {
      const original = fs[name];
      t.mock.method(fs, name, (...args) => {
        if (name === 'copyFileSync') counts.copies += 1;
        if ((name === 'writeFileSync' || name === 'renameSync')
          && String(args[name === 'renameSync' ? 1 : 0]).startsWith(resolve(stackDir, 'node_modules'))) counts.writes += 1;
        if (name === 'readFileSync' && String(args[0]).startsWith(repoRoot)
          && String(args[0]).endsWith('/dist/index.js')) counts.bodyReads += 1;
        return original(...args);
      });
    }
    syncBuiltinESMExports();
    try {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        await bundleWorkspaceDeps({ repoRoot, stackDir });
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(counts, { copies: 0, writes: 0, bodyReads: 0 });
    assert.equal(existsSync(resolve(stackDir, 'node_modules/@happier-dev/.workspace-bundle-manifest.json')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('Stack artifact preparation detaches a canonical source link retained by live preparation', async () => {
  const { repoRoot, stackDir, protocolDir } = createBundleFixture('happy-stack-bundle-source-link-');
  try {
    const destinationDir = resolve(stackDir, 'node_modules/@happier-dev/protocol');
    mkdirSync(dirname(destinationDir), { recursive: true });
    fs.symlinkSync(protocolDir, destinationDir, process.platform === 'win32' ? 'junction' : 'dir');
    await bundleWorkspaceDeps({ repoRoot, stackDir, publicationMode: 'live' });
    assert.equal(fs.lstatSync(destinationDir).isSymbolicLink(), true);
    await bundleWorkspaceDeps({ repoRoot, stackDir, publicationMode: 'artifact' });
    assert.equal(fs.lstatSync(destinationDir).isSymbolicLink(), false);
    assert.equal(readFileSync(resolve(destinationDir, 'dist/index.js'), 'utf8'),
      readFileSync(resolve(protocolDir, 'dist/index.js'), 'utf8'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps rebuilds a fresh live bundle in exact artifact mode', async () => {
  const { repoRoot, stackDir } = createBundleFixture('happy-stack-bundle-workspace-deps-artifact-refresh-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });
    const bundledProtocolDir = resolve(stackDir, 'node_modules', '@happier-dev', 'protocol');
    const retainedTargetPath = resolve(bundledProtocolDir, 'dist', 'retained.js');
    writeFileSync(retainedTargetPath, 'export const retained = true;\n', 'utf8');

    const admissionOptions = [];
    await bundleWorkspaceDeps({
      repoRoot,
      stackDir,
      publicationMode: 'artifact',
      ensureWorkspacePackagesBuiltByName: async (_root, _names, options) => {
        admissionOptions.push(options);
        return { ok: true, built: [], skipped: [] };
      },
    });

    assert.equal(existsSync(retainedTargetPath), false);
    assert.ok(admissionOptions.length > 0);
    assert.ok(admissionOptions.every((options) => options.force !== true));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when the source dist changes', async () => {
  const { repoRoot, stackDir, cliCommonDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-source-');
  try {
    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const bundledCliCommonDir = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common');
    const bundledCliCommonIndexPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js');
    const livePackageDirInode = statSync(bundledCliCommonDir).ino;

    const sourcePath = resolve(cliCommonDir, 'dist', 'index.js');
    const original = readFileSync(sourcePath, 'utf8');
    const originalTime = statSync(sourcePath).mtime;
    const changed = original.replace(/true|false|\d/u, (value) => value === 'true' ? 'fail' : value === 'false' ? 'false' : '4');
    assert.equal(changed.length, original.length);
    assert.notEqual(changed, original);
    writeFileSync(sourcePath, changed, 'utf8');
    utimesSync(sourcePath, originalTime, originalTime);

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(
      statSync(bundledCliCommonDir).ino,
      livePackageDirInode,
      'workspace refreshes must keep the live package directory mounted for concurrent resolvers',
    );
    assert.equal(readFileSync(bundledCliCommonIndexPath, 'utf8'), changed);
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

    const bundledCliCommonIndexPath = resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js');

    const expected = readFileSync(bundledCliCommonIndexPath, 'utf8');
    const before = statSync(bundledCliCommonIndexPath);
    writeFileSync(bundledCliCommonIndexPath, expected.replace('1', '9'));
    utimesSync(bundledCliCommonIndexPath, before.atime, before.mtime);
    await bundleWorkspaceDeps({ repoRoot, stackDir });
    assert.equal(readFileSync(bundledCliCommonIndexPath, 'utf8'), expected, 'existing dist corruption must be repaired');

    unlinkSync(bundledCliCommonIndexPath);

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(bundledCliCommonIndexPath), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bundleWorkspaceDeps refreshes the bundle when a bundled workspace is missing a non-exported dist runtime file', async () => {
  const { repoRoot, stackDir, agentsDir } = createBundleFixture('happy-stack-bundle-workspace-deps-refresh-internal-runtime-file-');
  try {
    mkdirSync(resolve(agentsDir, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      resolve(agentsDir, 'dist', 'manifest.js'),
      "import './cli/runtime.js';\nexport const manifest = true;\n",
      'utf8',
    );
    writeFileSync(
      resolve(agentsDir, 'dist', 'cli', 'runtime.js'),
      'export const agentCliRuntime = true;\n',
      'utf8',
    );

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    const bundledRuntimeFilePath = resolve(
      stackDir,
      'node_modules',
      '@happier-dev',
      'agents',
      'dist',
      'cli',
      'runtime.js',
    );

    unlinkSync(bundledRuntimeFilePath);

    await bundleWorkspaceDeps({ repoRoot, stackDir });

    assert.equal(existsSync(bundledRuntimeFilePath), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
