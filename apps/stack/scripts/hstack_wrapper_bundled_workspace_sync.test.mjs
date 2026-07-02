import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { coerceHappyMonorepoRootFromPath } from './utils/paths/paths.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

function createBundledWorkspaceSyncLoaderFixture(fixtureDir) {
  const syncMarkerPath = join(fixtureDir, 'sync.json');
  const syncStubPath = join(fixtureDir, 'syncBundledWorkspacePackages.mjs');
  const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
  const loaderPath = join(fixtureDir, 'loader.mjs');

  writeFileSync(
    syncStubPath,
    [
      "import { writeFileSync } from 'node:fs';",
      'export function syncBundledWorkspacePackages(opts) {',
      `  writeFileSync(${JSON.stringify(syncMarkerPath)}, JSON.stringify(opts), 'utf8');`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    resolveSyncModulePathStubPath,
    [
      'export function resolveBundledWorkspaceSyncModulePath() {',
      `  return ${JSON.stringify(syncStubPath)};`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    loaderPath,
    [
      "import { pathToFileURL } from 'node:url';",
      '',
      'export async function resolve(specifier, context, defaultResolve) {',
      "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
      '  }',
      '  return defaultResolve(specifier, context, defaultResolve);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  return { loaderPath, syncMarkerPath };
}

test('hstack wrapper refreshes bundled workspace packages in preflight mode without replacing existing directories', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);

    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), '--help'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const syncOptions = JSON.parse(readFileSync(syncMarkerPath, 'utf8'));
    assert.equal(syncOptions.repoRoot, repoRoot);
    assert.deepEqual(syncOptions.hostApps, ['stack']);
    assert.equal(syncOptions.replaceExisting, false);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper skips bundled workspace preflight for stack dev background json probes', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-skip-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'dev', 'main', '--background', '--json'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.equal(existsSync(syncMarkerPath), false, 'expected bundled workspace preflight to be skipped for background json probe');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper still runs bundled workspace preflight for nearby non-probe stack dev invocations', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-nearby-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'dev', 'main', '--background', '--help'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const syncOptions = JSON.parse(readFileSync(syncMarkerPath, 'utf8'));
    assert.equal(syncOptions.repoRoot, repoRoot);
    assert.deepEqual(syncOptions.hostApps, ['stack']);
    assert.equal(syncOptions.replaceExisting, false);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
