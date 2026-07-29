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

function createBundledWorkspaceSyncLoaderFixture(fixtureDir, options = {}) {
  const syncMarkerPath = join(fixtureDir, 'sync.json');
  const bundleMarkerPath = join(fixtureDir, 'bundle.json');
  const syncStubPath = join(fixtureDir, 'syncBundledWorkspacePackages.mjs');
  const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.mjs');
  const healthStubPath = join(fixtureDir, 'cliCommonWorkspaces.mjs');
  const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
  const loaderPath = join(fixtureDir, 'loader.mjs');
  const healthResults = Array.isArray(options.healthResults) && options.healthResults.length > 0
    ? options.healthResults.map(Boolean)
    : [false, true];
  const simulateMissingUpdateUntilSync = options.simulateMissingUpdateUntilSync === true;

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
    bundleStubPath,
    [
      "import { writeFileSync } from 'node:fs';",
      'export async function bundleWorkspaceDeps(opts) {',
      `  writeFileSync(${JSON.stringify(bundleMarkerPath)}, JSON.stringify(opts), 'utf8');`,
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
    healthStubPath,
    [
      `const healthResults = ${JSON.stringify(healthResults)};`,
      'let healthCallCount = 0;',
      'export function hasBundledWorkspacePackagesHealthy() {',
      '  const index = Math.min(healthCallCount, healthResults.length - 1);',
      '  healthCallCount += 1;',
      '  return healthResults[index];',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    loaderPath,
    [
      "import { existsSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      '',
      'export async function resolve(specifier, context, defaultResolve) {',
      "  if (specifier.endsWith('/packages/cli-common/dist/workspaces/index.js')) {",
      `    return { url: pathToFileURL(${JSON.stringify(healthStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
      '  }',
      ...(simulateMissingUpdateUntilSync
        ? [
            "  if (specifier === '@happier-dev/cli-common/update') {",
            `    if (!existsSync(${JSON.stringify(syncMarkerPath)})) {`,
            "      const error = new Error('Package subpath ./update is not defined by exports in partial bundled @happier-dev/cli-common copy');",
            "      error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';",
            '      throw error;',
            '    }',
            '  }',
          ]
        : []),
      '  return defaultResolve(specifier, context, defaultResolve);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  return { bundleMarkerPath, loaderPath, syncMarkerPath };
}

test('hstack wrapper refreshes bundled workspace packages for normal commands without replacing existing directories', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      simulateMissingUpdateUntilSync: true,
    });

    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'where', '--json'], {
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

test('hstack dependency-importing command help retains bundled workspace preflight repair', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-help-skip-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      simulateMissingUpdateUntilSync: true,
    });
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', '--help'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stdout, /hstack stack/);
    const syncOptions = JSON.parse(readFileSync(syncMarkerPath, 'utf8'));
    assert.equal(syncOptions.replaceExisting, false, 'command help must retain partial-copy repair semantics');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack exact installed start --restart exits successfully before preflight when explicit env is missing', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-missing-service-env-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);
    const missingEnvPath = join(fixtureDir, 'archived-stack', 'env');
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'start', '--restart'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_ENV_FILE: missingEnvPath,
        HAPPIER_STACK_SERVICE_MODE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `missing installed-service env must terminate successfully\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /configured stack env file is missing/i);
    assert.equal(existsSync(syncMarkerPath), false, 'missing env must terminate before workspace preflight');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack other missing-env commands fail clearly even in service mode', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-missing-service-env-other-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);
    const missingEnvPath = join(fixtureDir, 'archived-stack', 'env');
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'where'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_ENV_FILE: missingEnvPath,
        HAPPIER_STACK_SERVICE_MODE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /configured stack env file is missing/i);
    assert.equal(existsSync(syncMarkerPath), false, 'missing env must fail before workspace preflight');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack root help remains dependency-free with a missing explicit env and partial bundled cli-common', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-missing-service-env-help-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      simulateMissingUpdateUntilSync: true,
    });
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), '--help'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_ENV_FILE: join(fixtureDir, 'missing', 'env'),
        HAPPIER_STACK_SERVICE_MODE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `root help must remain available\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /hstack/);
    assert.equal(existsSync(syncMarkerPath), false, 'dependency-free root help remains preflight-free');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

for (const { title, args } of [
  { title: 'bare hstack root help remains dependency-free with partial bundled cli-common', args: [] },
  { title: 'hstack -h root help remains dependency-free with partial bundled cli-common', args: ['-h'] },
  { title: 'hstack help root help remains dependency-free with partial bundled cli-common', args: ['help'] },
]) {
  test(title, async () => {
    const rootDir = stackRootDirFromMeta(import.meta.url);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-partial-root-help-'));
    try {
      const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
        simulateMissingUpdateUntilSync: true,
      });
      const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), ...args], {
        cwd: rootDir,
        env: {
          ...process.env,
          HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
          NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
        },
      });

      assert.equal(res.code, 0, `root help must remain available\nstderr:\n${res.stderr}`);
      assert.match(res.stdout, /hstack/);
      assert.equal(existsSync(syncMarkerPath), false, 'dependency-free root help remains preflight-free');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
}

test('hstack help command routing retains bundled workspace preflight repair', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-help-command-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      simulateMissingUpdateUntilSync: true,
    });
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'help', 'stack'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `routed command help must remain available\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /hstack stack/);
    const syncOptions = JSON.parse(readFileSync(syncMarkerPath, 'utf8'));
    assert.equal(syncOptions.replaceExisting, false, 'help command routing must retain partial-copy repair semantics');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper refreshes bundled workspace packages for happier passthrough help', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-happier-help-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'happier', '--help'], {
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

for (const subcommand of ['dev', 'start']) {
  test(`hstack wrapper keeps stack ${subcommand} background json probes dependency-free`, async () => {
    const rootDir = stackRootDirFromMeta(import.meta.url);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-skip-'));
    try {
      const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
        simulateMissingUpdateUntilSync: true,
      });
      const res = await runNodeCapture(
        [join(rootDir, 'bin', 'hstack.mjs'), 'stack', subcommand, 'main', '--background', '--json'],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
            HAPPIER_STACK_UPDATE_CHECK: '0',
            NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
          },
        },
      );

      assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
      assert.doesNotThrow(() => JSON.parse(res.stdout), `expected parseable JSON stdout:\n${res.stdout}`);
      assert.equal(existsSync(syncMarkerPath), false, 'expected bundled workspace preflight to be skipped for background json probe');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
}

for (const command of ['setup', 'setup-from-source']) {
  test(`hstack wrapper keeps ${command} json config probes dependency-free`, async () => {
    const rootDir = stackRootDirFromMeta(import.meta.url);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-setup-json-skip-'));
    try {
      const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
        simulateMissingUpdateUntilSync: true,
      });
      const res = await runNodeCapture(
        [
          join(rootDir, 'bin', 'hstack.mjs'),
          command,
          '--json',
          '--profile=selfhost',
          '--server=happier-server-light',
          '--no-auth',
          '--no-tailscale',
          '--no-autostart',
          '--no-menubar',
          '--no-start-now',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
            HAPPIER_STACK_UPDATE_CHECK: '0',
            NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
          },
        },
      );

      assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
      assert.doesNotThrow(() => JSON.parse(res.stdout), `expected parseable JSON stdout:\n${res.stdout}`);
      assert.equal(existsSync(syncMarkerPath), false, 'expected bundled workspace preflight to be skipped for setup json probe');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
}

test('hstack wrapper still runs bundled workspace preflight for non-help stack invocations', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-nearby-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'list', '--json'], {
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
