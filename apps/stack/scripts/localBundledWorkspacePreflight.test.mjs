import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const stackDir = resolve(scriptsDir, '..');
const preflightModulePath = resolve(stackDir, 'bin', 'localBundledWorkspacePreflight.mjs');
const bundleWorkspaceDepsModulePath = resolve(stackDir, 'scripts', 'bundleWorkspaceDeps.mjs');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendNodeLoader(nodeOptions, loaderPath) {
  const existing = String(nodeOptions ?? '').trim();
  const loaderOption = `--experimental-loader=${loaderPath}`;
  return existing ? `${existing} ${loaderOption}` : loaderOption;
}

function writeBundleWorkspaceDepsStub({ fixtureDir, markerPath, loadModulePath = null }) {
  const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.stub.mjs');
  writeFileSync(
    bundleStubPath,
    [
      "import { writeFileSync } from 'node:fs';",
      ...(loadModulePath ? [`import ${JSON.stringify(pathToFileURL(loadModulePath).href)};`] : []),
      'export async function bundleWorkspaceDeps(opts) {',
      `  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(opts), 'utf8');`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return bundleStubPath;
}

function writeBundleWorkspaceDepsLoader({
  fixtureDir,
  bundleStubPath,
  missingCliCommonProcessDistPath = null,
}) {
  const loaderPath = join(fixtureDir, 'bundleWorkspaceDeps.loader.mjs');
  writeFileSync(
    loaderPath,
    [
      "import { pathToFileURL } from 'node:url';",
      '',
      'export async function resolve(specifier, context, defaultResolve) {',
      ...(missingCliCommonProcessDistPath
        ? [
            "  if (specifier === '@happier-dev/cli-common/process') {",
            `    const error = new Error(${JSON.stringify(`Cannot find module '${missingCliCommonProcessDistPath}'`)});`,
            "    error.code = 'ERR_MODULE_NOT_FOUND';",
            '    throw error;',
            '  }',
          ]
        : []),
      "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
      '  }',
      '  return defaultResolve(specifier, context, defaultResolve);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return loaderPath;
}

function createFixtureRepo(prefix) {
  const fixtureDir = mkdtempSync(join(tmpdir(), prefix));
  const repoRoot = resolve(fixtureDir, 'repo');
  const hostPackageDir = resolve(repoRoot, 'apps', 'stack');
  const protocolSrcDir = resolve(repoRoot, 'packages', 'protocol');
  const bundledProtocolDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol');
  const cliCommonWorkspacesDir = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces');

  mkdirSync(hostPackageDir, { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps', 'ui'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps', 'cli'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps', 'server'), { recursive: true });
  mkdirSync(resolve(protocolSrcDir, 'dist'), { recursive: true });
  mkdirSync(resolve(bundledProtocolDir, 'dist'), { recursive: true });
  mkdirSync(cliCommonWorkspacesDir, { recursive: true });

  writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
  writeFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), '# lock\n', 'utf8');
  writeFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  writeJson(resolve(repoRoot, 'apps', 'ui', 'package.json'), { name: '@happier-dev/ui', private: true });
  writeJson(resolve(repoRoot, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  writeJson(resolve(repoRoot, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });
  writeJson(resolve(repoRoot, 'packages', 'cli-common', 'package.json'), {
    name: '@happier-dev/cli-common',
    private: true,
    type: 'module',
  });
  writeJson(resolve(hostPackageDir, 'package.json'), {
    name: '@happier-dev/stack',
    private: true,
    bundledDependencies: ['@happier-dev/protocol'],
    dependencies: { '@happier-dev/protocol': '0.0.0' },
  });

  return { bundledProtocolDir, fixtureDir, hostPackageDir, protocolSrcDir, repoRoot };
}

function writeProtocolWorkspacePackage({ protocolSrcDir, bundledProtocolDir, workspacePackageJson, bundledPackageJson }) {
  writeJson(resolve(protocolSrcDir, 'package.json'), workspacePackageJson);
  writeJson(resolve(bundledProtocolDir, 'package.json'), bundledPackageJson);
  writeFileSync(resolve(protocolSrcDir, 'dist', 'index.js'), 'export const protocol = true;\n', 'utf8');
  writeFileSync(resolve(bundledProtocolDir, 'dist', 'index.js'), 'export const protocol = true;\n', 'utf8');
}

function writeSyncHelper({ repoRoot, markerPath }) {
  const syncModulePath = resolve(repoRoot, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  mkdirSync(dirname(syncModulePath), { recursive: true });
  writeFileSync(
    syncModulePath,
    [
      "import { writeFileSync } from 'node:fs';",
      'export function syncBundledWorkspacePackages(opts) {',
      `  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(opts), 'utf8');`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return syncModulePath;
}

function writeFailingSyncHelper({ repoRoot, message }) {
  const syncModulePath = resolve(repoRoot, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  mkdirSync(dirname(syncModulePath), { recursive: true });
  writeFileSync(
    syncModulePath,
    [
      'export function syncBundledWorkspacePackages() {',
      `  throw new Error(${JSON.stringify(message)});`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return syncModulePath;
}

function writeCliCommonHealthModule({ repoRoot, markerPath, bodyLines }) {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  writeFileSync(
    modulePath,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      '',
      'export function hasBundledWorkspacePackagesHealthy(opts) {',
      `  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(opts), 'utf8');`,
      ...bodyLines.map((line) => `  ${line}`),
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return modulePath;
}

async function runPreflight({ cwd, hostPackageDir, loaderPath }) {
  return await runNodeCapture(
    [
      '--input-type=module',
      '-e',
      `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(preflightModulePath)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(hostPackageDir)});`,
    ],
    {
      cwd,
      env: {
        ...process.env,
        NODE_OPTIONS: appendNodeLoader(process.env.NODE_OPTIONS, loaderPath),
      },
    },
  );
}

test('local bundled workspace preflight falls back to bundleWorkspaceDeps when the monorepo sync helper is unavailable', async () => {
  const { fixtureDir, hostPackageDir, repoRoot } = createFixtureRepo('local-bundled-preflight-fallback-');
  const bundleMarkerPath = join(fixtureDir, 'bundle.json');
  const bundleStubPath = writeBundleWorkspaceDepsStub({
    fixtureDir,
    markerPath: bundleMarkerPath,
    loadModulePath: bundleWorkspaceDepsModulePath,
  });
  const loaderPath = writeBundleWorkspaceDepsLoader({
    fixtureDir,
    bundleStubPath,
    missingCliCommonProcessDistPath: resolve(
      repoRoot,
      'packages',
      'cli-common',
      'dist',
      'process',
      'index.js',
    ),
  });

  try {
    const res = await runPreflight({ cwd: repoRoot, hostPackageDir, loaderPath });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const bundleOptions = JSON.parse(readFileSync(bundleMarkerPath, 'utf8'));
    assert.equal(bundleOptions.repoRoot, repoRoot);
    assert.equal(bundleOptions.stackDir, hostPackageDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight builds missing source dist when the fast sync cannot publish it', async () => {
  const { fixtureDir, hostPackageDir, repoRoot } = createFixtureRepo('local-bundled-preflight-missing-dist-');
  const healthMarkerPath = join(fixtureDir, 'health.json');
  const bundleMarkerPath = join(fixtureDir, 'bundle.json');
  const bundleStubPath = writeBundleWorkspaceDepsStub({ fixtureDir, markerPath: bundleMarkerPath });
  const loaderPath = writeBundleWorkspaceDepsLoader({ fixtureDir, bundleStubPath });

  writeFailingSyncHelper({
    repoRoot,
    message: 'Missing bundled workspace package dist: /repo/packages/agents/dist',
  });
  writeCliCommonHealthModule({
    repoRoot,
    markerPath: healthMarkerPath,
    bodyLines: ['return false;'],
  });

  try {
    const res = await runPreflight({ cwd: repoRoot, hostPackageDir, loaderPath });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const bundleOptions = JSON.parse(readFileSync(bundleMarkerPath, 'utf8'));
    assert.equal(bundleOptions.repoRoot, repoRoot);
    assert.equal(bundleOptions.stackDir, hostPackageDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight refreshes a changed producer runtime dependency before wrapper imports', async () => {
  const { fixtureDir, hostPackageDir, protocolSrcDir, repoRoot } = createFixtureRepo('local-bundled-preflight-vendor-refresh-');
  try {
    const sourceRepo = resolve(stackDir, '../..');
    for (const path of [
      'scripts/workspaces/syncBundledWorkspacePackages.mjs',
      'scripts/workspaces/workspaceBundlePublication.mjs',
      'scripts/workspaces/vendorBundledWorkspaceRuntimeDependenciesFallback.mjs',
      'packages/cli-common/dist/workspaces/index.js',
      'packages/cli-common/workspaceRuntimeDependencies.mjs',
      'packages/cli-common/bundledPluginResources.mjs',
      'packages/cli-common/packageBuildOutputTargets.mjs',
      'apps/stack/scripts/utils/fs/cached_file_digest.mjs',
    ]) {
      mkdirSync(dirname(resolve(repoRoot, path)), { recursive: true });
      cpSync(resolve(sourceRepo, path), resolve(repoRoot, path));
    }
    cpSync(resolve(sourceRepo, 'node_modules/semver'), resolve(repoRoot, 'node_modules/semver'), { recursive: true });
    writeJson(resolve(protocolSrcDir, 'package.json'), {
      name: '@happier-dev/protocol', version: '0.0.0', type: 'module',
      exports: { '.': './dist/index.js' }, dependencies: { 'fixture-runtime': '^1.0.0' },
    });
    writeFileSync(resolve(protocolSrcDir, 'dist/index.js'), 'export { generation } from "fixture-runtime";\n');
    const runtime = resolve(protocolSrcDir, 'node_modules/fixture-runtime');
    mkdirSync(runtime, { recursive: true });
    const publishDependency = generation => {
      writeJson(resolve(runtime, 'package.json'), {
        name: 'fixture-runtime', version: generation === 'previous' ? '1.0.0' : '1.1.0',
        type: 'module', main: './index.js',
      });
      writeFileSync(resolve(runtime, 'index.js'), `export const generation = ${JSON.stringify(generation)};\n`);
    };
    publishDependency('previous');
    const copier = await import(pathToFileURL(resolve(repoRoot, 'scripts/workspaces/syncBundledWorkspacePackages.mjs')).href);
    copier.syncBundledWorkspacePackages({ repoRoot, hostApps: ['stack'], packages: ['protocol'] });
    publishDependency('current');
    mkdirSync(resolve(hostPackageDir, 'bin'), { recursive: true });
    for (const file of ['happier.mjs', 'localSourceRuntimeBootstrap.mjs']) {
      cpSync(resolve(stackDir, 'bin', file), resolve(hostPackageDir, 'bin', file));
    }
    // Relocate the entry without replacing any preflight or health logic.
    writeFileSync(resolve(hostPackageDir, 'bin/localBundledWorkspacePreflight.mjs'),
      `export * from ${JSON.stringify(pathToFileURL(preflightModulePath).href)};\n`);
    mkdirSync(resolve(hostPackageDir, 'scripts'), { recursive: true });
    writeFileSync(resolve(hostPackageDir, 'scripts/happier_main.mjs'),
      'process.stdout.write((await import("@happier-dev/protocol")).generation);\n');
    const loaded = execFileSync(process.execPath, [resolve(hostPackageDir, 'bin/happier.mjs')],
    { cwd: hostPackageDir, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
    assert.equal(loaded, 'current');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight admits stale-present cli-common before checking bundle health', async () => {
  const {
    bundledProtocolDir,
    fixtureDir,
    hostPackageDir,
    protocolSrcDir,
    repoRoot,
  } = createFixtureRepo('local-bundled-preflight-cli-common-admission-');
  const healthMarkerPath = join(fixtureDir, 'health.json');
  const generationMarkerPath = join(fixtureDir, 'generation.txt');

  writeProtocolWorkspacePackage({
    protocolSrcDir,
    bundledProtocolDir,
    workspacePackageJson: {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    },
    bundledPackageJson: {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    },
  });
  writeCliCommonHealthModule({
    repoRoot,
    markerPath: healthMarkerPath,
    bodyLines: [
      `writeFileSync(${JSON.stringify(generationMarkerPath)}, 'stale', 'utf8');`,
      'return true;',
    ],
  });

  try {
    const { refreshLocalBundledWorkspacePackages } = await import(pathToFileURL(preflightModulePath).href);
    await refreshLocalBundledWorkspacePackages(hostPackageDir, {
      ensureWorkspacePackagesBuiltByName: async () => {
        writeCliCommonHealthModule({
          repoRoot,
          markerPath: healthMarkerPath,
          bodyLines: [
            `writeFileSync(${JSON.stringify(generationMarkerPath)}, 'fresh', 'utf8');`,
            'return true;',
          ],
        });
        return { ok: true, built: ['@happier-dev/cli-common'], skipped: [] };
      },
    });

    assert.equal(readFileSync(generationMarkerPath, 'utf8'), 'fresh');
    const healthOptions = JSON.parse(readFileSync(healthMarkerPath, 'utf8'));
    assert.equal(healthOptions.repoRoot, repoRoot);
    assert.equal(healthOptions.hostPackageDir, hostPackageDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight falls back to bundleWorkspaceDeps when cli-common detects a missing bundled export target', async () => {
  const { bundledProtocolDir, fixtureDir, hostPackageDir, protocolSrcDir, repoRoot } = createFixtureRepo('local-bundled-preflight-export-fallback-');
  const syncMarkerPath = join(fixtureDir, 'sync.json');
  const healthMarkerPath = join(fixtureDir, 'health.json');
  const bundleMarkerPath = join(fixtureDir, 'bundle.json');
  const bundleStubPath = writeBundleWorkspaceDepsStub({ fixtureDir, markerPath: bundleMarkerPath });
  const loaderPath = writeBundleWorkspaceDepsLoader({ fixtureDir, bundleStubPath });

  writeProtocolWorkspacePackage({
    protocolSrcDir,
    bundledProtocolDir,
    workspacePackageJson: {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': { default: './dist/index.js' },
        './feature': { default: './dist/feature.js' },
      },
    },
    bundledPackageJson: {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: {
        '.': { default: './dist/index.js' },
        './feature': { default: './dist/feature.js' },
      },
    },
  });
  writeFileSync(resolve(protocolSrcDir, 'dist', 'feature.js'), 'export const feature = true;\n', 'utf8');
  writeSyncHelper({ repoRoot, markerPath: syncMarkerPath });
  writeCliCommonHealthModule({
    repoRoot,
    markerPath: healthMarkerPath,
    bodyLines: [
      "return existsSync(resolve(opts.hostPackageDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'feature.js'));",
    ],
  });

  try {
    const res = await runPreflight({ cwd: repoRoot, hostPackageDir, loaderPath });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const syncOptions = JSON.parse(readFileSync(syncMarkerPath, 'utf8'));
    assert.equal(syncOptions.repoRoot, repoRoot);
    const healthOptions = JSON.parse(readFileSync(healthMarkerPath, 'utf8'));
    assert.equal(healthOptions.hostPackageDir, hostPackageDir);
    const bundleOptions = JSON.parse(readFileSync(bundleMarkerPath, 'utf8'));
    assert.equal(bundleOptions.repoRoot, repoRoot);
    assert.equal(bundleOptions.stackDir, hostPackageDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight falls back to bundleWorkspaceDeps when cli-common detects missing nested vendored runtime deps', async () => {
  const { bundledProtocolDir, fixtureDir, hostPackageDir, protocolSrcDir, repoRoot } = createFixtureRepo('local-bundled-preflight-runtime-fallback-');
  const syncMarkerPath = join(fixtureDir, 'sync.json');
  const healthMarkerPath = join(fixtureDir, 'health.json');
  const bundleMarkerPath = join(fixtureDir, 'bundle.json');
  const bundleStubPath = writeBundleWorkspaceDepsStub({ fixtureDir, markerPath: bundleMarkerPath });
  const loaderPath = writeBundleWorkspaceDepsLoader({ fixtureDir, bundleStubPath });
  const bundledZodDir = resolve(bundledProtocolDir, 'node_modules', 'zod');

  writeProtocolWorkspacePackage({
    protocolSrcDir,
    bundledProtocolDir,
    workspacePackageJson: {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: { zod: '4.3.6' },
    },
    bundledPackageJson: {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: { zod: '4.3.6' },
    },
  });
  mkdirSync(bundledZodDir, { recursive: true });
  writeJson(resolve(bundledZodDir, 'package.json'), {
    name: 'zod',
    version: '4.3.6',
    type: 'module',
    exports: { '.': { default: './index.js' } },
    dependencies: { nanoid: '5.0.0' },
  });
  writeFileSync(resolve(bundledZodDir, 'index.js'), 'export const zod = true;\n', 'utf8');
  writeSyncHelper({ repoRoot, markerPath: syncMarkerPath });
  writeCliCommonHealthModule({
    repoRoot,
    markerPath: healthMarkerPath,
    bodyLines: [
      "return existsSync(resolve(opts.hostPackageDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'zod', 'node_modules', 'nanoid', 'package.json'));",
    ],
  });

  try {
    const res = await runPreflight({ cwd: repoRoot, hostPackageDir, loaderPath });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const syncOptions = JSON.parse(readFileSync(syncMarkerPath, 'utf8'));
    assert.equal(syncOptions.repoRoot, repoRoot);
    const healthOptions = JSON.parse(readFileSync(healthMarkerPath, 'utf8'));
    assert.equal(healthOptions.hostPackageDir, hostPackageDir);
    const bundleOptions = JSON.parse(readFileSync(bundleMarkerPath, 'utf8'));
    assert.equal(bundleOptions.repoRoot, repoRoot);
    assert.equal(bundleOptions.stackDir, hostPackageDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
