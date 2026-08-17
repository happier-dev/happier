import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { buildStackFixtureEnv } from './testkit/core/env_scope.mjs';
import { ensureMinimalMonorepoLayout } from './testkit/core/minimal_monorepo_layout.mjs';
import { createStartableRuntimeSnapshotFixture } from './testkit/runtime_snapshot_start_testkit.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';
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
  const healthLoaderStubPath = join(fixtureDir, 'loadCliCommonWorkspacesModule.mjs');
  const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
  const loaderPath = join(fixtureDir, 'loader.mjs');
  const healthResults = Array.isArray(options.healthResults) && options.healthResults.length > 0
    ? options.healthResults.map(Boolean)
    : [false, true];
  const failPreflight = options.failPreflight === true;
  const rejectCliCommonLinks = options.rejectCliCommonLinks === true;
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
      ...(failPreflight ? ["  throw new Error('test bundled workspace preflight is unavailable');"] : []),
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
    healthLoaderStubPath,
    [
      `import * as helpers from ${JSON.stringify(pathToFileURL(healthStubPath).href)};`,
      'export async function loadCliCommonWorkspacesModule() {',
      '  return helpers;',
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
      "  if (specifier.endsWith('/scripts/workspaces/loadCliCommonWorkspacesModule.mjs')) {",
      `    return { url: pathToFileURL(${JSON.stringify(healthLoaderStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier.endsWith('/packages/cli-common/dist/workspaces/index.js')) {",
      `    return { url: pathToFileURL(${JSON.stringify(healthStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
      '  }',
      ...(rejectCliCommonLinks
        ? [
            "  if (specifier === '@happier-dev/cli-common/links') {",
            "    throw new Error('test copied cli-common links module is unavailable');",
            '  }',
          ]
        : []),
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

function createStackManagementFixture(fixtureDir, stackName = 'qa-stack') {
  const storageDir = join(fixtureDir, 'storage');
  const envPath = join(storageDir, stackName, 'env');
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
  return { envPath, stackName, storageDir };
}

function bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir }) {
  return buildStackFixtureEnv({
    homeDir: join(fixtureDir, 'home'),
    storageDir,
    stripStackEnv: true,
    extraEnv: {
      HAPPIER_STACK_UPDATE_CHECK: '0',
      NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
    },
  });
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

test('hstack dependency-importing command help stays read-only when bundled workspace publication is unavailable', async () => {
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
    assert.equal(existsSync(syncMarkerPath), false, 'command help must not publish bundled workspace packages');
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

test('hstack help command routing stays read-only when bundled workspace publication is unavailable', async () => {
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
    assert.equal(existsSync(syncMarkerPath), false, 'help command routing must not publish bundled workspace packages');
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

test('hstack wrapper keeps dependency-free dev-target commands responsive during workspace builds', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-dev-targets-skip-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      simulateMissingUpdateUntilSync: true,
    });
    const res = await runNodeCapture(
      [join(rootDir, 'bin', 'hstack.mjs'), 'dev-targets', 'path', '--stack=repo-test'],
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
    assert.match(res.stdout, /repo-test/);
    assert.equal(
      existsSync(syncMarkerPath),
      false,
      'dependency-free dev-target commands must not wait for unrelated bundled workspace publication',
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper dispatches the TUI before bundled workspace publication', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-tui-skip-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'tui', 'dev'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_UPDATE_CHECK: '0',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /requires a TTY/i, 'the TUI owner must be reached before any workspace publication');
    assert.equal(existsSync(syncMarkerPath), false, 'TUI dispatch must not synchronize bundled workspace packages');
    assert.equal(existsSync(bundleMarkerPath), false, 'TUI dispatch must not publish bundled workspace packages');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper lets a TUI-owned source-dev child reach its scoped build owners', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-tui-child-skip-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'dev', '--json'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_TUI: '1',
        HAPPIER_STACK_UPDATE_CHECK: '0',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.doesNotMatch(res.stderr, /test bundled workspace preflight is unavailable/);
    assert.equal(existsSync(syncMarkerPath), false, 'the TUI child must not synchronize every bundled workspace package');
    assert.equal(existsSync(bundleMarkerPath), false, 'the TUI child must not publish every bundled workspace package');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper keeps Stack-local management commands available when bundled workspace preflight is unavailable', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-management-skip-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { envPath, stackName, storageDir } = createStackManagementFixture(fixtureDir);
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const invocations = [
      {
        args: ['stack', 'list', '--json'],
        label: 'stack list',
        verify: (res) => assert.doesNotThrow(() => JSON.parse(res.stdout), `expected stack list JSON\n${res.stdout}`),
      },
      {
        args: ['stack', 'info', stackName, '--json'],
        label: 'stack info',
        verify: (res) => assert.doesNotThrow(() => JSON.parse(res.stdout), `expected stack info JSON\n${res.stdout}`),
      },
      {
        args: ['stack', 'auth', stackName, 'status', '--json'],
        label: 'stack auth status',
        verify: (res) => assert.doesNotThrow(() => JSON.parse(res.stdout), `expected stack auth status JSON\n${res.stdout}`),
      },
      {
        args: ['stack', 'doctor', stackName, '--json'],
        label: 'stack doctor',
        verify: (res) => assert.doesNotThrow(() => JSON.parse(res.stdout), `expected stack doctor JSON\n${res.stdout}`),
      },
      {
        args: [stackName, 'env', 'path', '--json'],
        label: 'stack shorthand env path',
        verify: (res) => assert.doesNotThrow(() => JSON.parse(res.stdout), `expected shorthand env path JSON\n${res.stdout}`),
      },
      {
        args: ['stack', 'env', stackName, 'set', 'HSTACK_PREFLIGHT_TEST=1', '--json'],
        label: 'stack env set',
        verify: (res) => assert.doesNotThrow(() => JSON.parse(res.stdout), `expected stack env JSON\n${res.stdout}`),
      },
    ];

    for (const invocation of invocations) {
      const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), ...invocation.args], { cwd: rootDir, env });
      assert.equal(
        res.code,
        0,
        `${invocation.label} must not wait for bundled workspace publication\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
      );
      invocation.verify(res);
      assert.equal(existsSync(syncMarkerPath), false, `${invocation.label} must not invoke the bundled workspace sync`);
      assert.equal(existsSync(bundleMarkerPath), false, `${invocation.label} must not invoke the bundled workspace fallback`);
    }

    assert.match(readFileSync(envPath, 'utf8'), /HSTACK_PREFLIGHT_TEST=1/, 'stack-local env mutation must reach the owning env file');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack unsupported stack status reports without publishing bundled workspace packages', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-status-read-only-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { stackName, storageDir } = createStackManagementFixture(fixtureDir);
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const res = await runNodeCapture(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'status', stackName, '--json'],
      { cwd: rootDir, env },
    );

    assert.equal(res.code, 0);
    assert.match(res.stdout, /unknown command: status/i);
    assert.equal(existsSync(syncMarkerPath), false);
    assert.equal(existsSync(bundleMarkerPath), false);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper creates a controlled no-copy-auth stack without waiting for publication or prompting in a TTY', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-new-no-copy-auth-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { storageDir } = createStackManagementFixture(fixtureDir);
    const repoDir = join(fixtureDir, 'repo');
    await ensureMinimalMonorepoLayout(repoDir);
    const env = {
      ...bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir }),
      HAPPIER_STACK_TEST_TTY: '1',
    };
    const stackName = 'controlled-no-auth';
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'new',
      stackName,
      `--repo=${repoDir}`,
      '--server=happier-server-light',
      '--db-provider=sqlite',
      '--no-copy-auth',
      '--non-interactive',
    ], {
      cwd: rootDir,
      env,
      // If --non-interactive regresses, the TTY wizard consumes these values
      // and persists `origin` instead of the non-interactive `upstream` default.
      input: 'ephemeral\norigin\n',
    });

    assert.equal(
      res.code,
      0,
      `no-copy-auth stack creation must not wait for bundled workspace publication\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    const createdEnvPath = join(storageDir, stackName, 'env');
    assert.equal(existsSync(createdEnvPath), true, 'new stack must persist its own env');
    const createdEnv = readFileSync(createdEnvPath, 'utf8');
    assert.match(createdEnv, /HAPPIER_STACK_STACK_REMOTE=upstream\n/, 'non-interactive create must retain the default remote');
    assert.equal(existsSync(syncMarkerPath), false, 'no-copy-auth stack creation must not synchronize workspace packages');
    assert.equal(existsSync(bundleMarkerPath), false, 'no-copy-auth stack creation must not publish workspace packages');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper keeps auth-copying stack creation behind bundled workspace preflight', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-new-copy-auth-preflight-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { storageDir } = createStackManagementFixture(fixtureDir);
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const stackName = 'auth-copy-stack';
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'new',
      stackName,
      '--non-interactive',
      '--json',
    ], { cwd: rootDir, env });

    assert.notEqual(res.code, 0, 'auth-copying creation must retain bundled workspace preflight');
    assert.match(res.stderr, /test bundled workspace preflight is unavailable/);
    assert.equal(existsSync(join(storageDir, stackName, 'env')), false, 'preflight failure must not create the target stack');
    assert.equal(existsSync(syncMarkerPath), true, 'auth-copying creation must attempt the normal bundled workspace sync');
    assert.equal(existsSync(bundleMarkerPath), true, 'auth-copying creation must invoke the bundled workspace fallback');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper keeps stack stop responsive while bundled workspace preflight is unavailable', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-stop-skip-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { envPath, stackName, storageDir } = createStackManagementFixture(fixtureDir);
    const repoDir = join(fixtureDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${repoDir}`,
        'HAPPIER_STACK_STOP_AUTO_SWEEP=0',
        '',
      ].join('\n'),
      'utf8',
    );
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'stop',
      stackName,
      '--no-docker',
      '--json',
    ], { cwd: rootDir, env });

    assert.equal(
      res.code,
      0,
      `stack stop must not wait for bundled workspace publication\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.doesNotThrow(() => JSON.parse(res.stdout), `expected stack stop JSON\n${res.stdout}`);
    assert.equal(existsSync(syncMarkerPath), false, 'stack stop must not invoke the bundled workspace sync');
    assert.equal(existsSync(bundleMarkerPath), false, 'stack stop must not invoke the bundled workspace fallback');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper leaves a missing copied module as a loud Stack-local management error', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-management-missing-copy-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
      rejectCliCommonLinks: true,
    });
    const { storageDir } = createStackManagementFixture(fixtureDir);
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'list', '--json'], { cwd: rootDir, env });

    assert.notEqual(res.code, 0, 'a missing copied module must fail rather than report a fabricated stack status');
    assert.match(res.stderr, /test copied cli-common links module is unavailable/);
    assert.equal(existsSync(syncMarkerPath), false, 'the Stack-local command must not turn a missing copied module into a preflight publication');
    assert.equal(existsSync(bundleMarkerPath), false, 'the Stack-local command must not invoke the preflight fallback');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper starts an explicit runtime snapshot without bundled workspace publication', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-runtime-start-skip-'));
  try {
    const fixture = await createStartableRuntimeSnapshotFixture(t, {
      stackName: 'runtime-start-without-publication',
    });
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const env = bundledWorkspaceFailureEnv({
      fixtureDir,
      loaderPath,
      storageDir: fixture.storageDir,
    });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'start',
      fixture.stackName,
      '--runtime',
      '--restart',
      '--no-browser',
      '--json',
    ], { cwd: rootDir, env });

    assert.equal(res.code, 0, `explicit runtime start must not wait for bundled workspace publication\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.launchMode, 'runtime');
    assert.equal(parsed.runtimeSnapshotId, 'snap-startable');
    assert.equal(existsSync(syncMarkerPath), false, 'explicit runtime start must not invoke bundled workspace sync');
    assert.equal(existsSync(bundleMarkerPath), false, 'explicit runtime start must not invoke bundled workspace fallback');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper runs an explicit runtime CLI without bundled workspace publication', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-runtime-cli-skip-'));
  try {
    const fixture = await createRuntimeSnapshotFixture(t, {
      stackName: 'runtime-cli-without-publication',
      cliEntrypoint: 'cli/happier.mjs',
      cliSource: 'process.stdout.write("SNAPSHOT CLI HELP\\n");\n',
    });
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const env = bundledWorkspaceFailureEnv({
      fixtureDir,
      loaderPath,
      storageDir: fixture.storageDir,
    });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'happier',
      fixture.stackName,
      '--runtime',
      '--',
      '--help',
    ], { cwd: rootDir, env });

    assert.equal(res.code, 0, `explicit runtime CLI must not wait for bundled workspace publication\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stdout, /SNAPSHOT CLI HELP/);
    assert.equal(existsSync(syncMarkerPath), false, 'explicit runtime CLI must not invoke bundled workspace sync');
    assert.equal(existsSync(bundleMarkerPath), false, 'explicit runtime CLI must not invoke bundled workspace fallback');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack stack-name shorthand uses a required runtime CLI without publishing the launcher checkout', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-runtime-cli-shorthand-skip-'));
  try {
    const fixture = await createRuntimeSnapshotFixture(t, {
      stackName: 'runtime-cli-shorthand-without-publication',
      cliEntrypoint: 'cli/happier.mjs',
      cliSource: 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
    });
    const stackEnvPath = join(fixture.storageDir, fixture.stackName, 'env');
    writeFileSync(
      stackEnvPath,
      `${readFileSync(stackEnvPath, 'utf8')}HAPPIER_STACK_STACK=${fixture.stackName}\nHAPPIER_STACK_RUNTIME_MODE=require\n`,
      'utf8',
    );
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const env = bundledWorkspaceFailureEnv({
      fixtureDir,
      loaderPath,
      storageDir: fixture.storageDir,
    });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      fixture.stackName,
      'happier',
      'doctor',
      '--json',
    ], { cwd: rootDir, env });

    assert.equal(
      res.code,
      0,
      `required runtime shorthand must not publish the launcher checkout\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.deepEqual(JSON.parse(res.stdout), ['doctor', '--json']);
    assert.equal(existsSync(syncMarkerPath), false, 'runtime shorthand must not invoke bundled workspace sync');
    assert.equal(existsSync(bundleMarkerPath), false, 'runtime shorthand must not invoke bundled workspace fallback');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack stack-name shorthand delegates source CLI preparation to the selected checkout', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-source-cli-foreign-checkout-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { envPath, stackName, storageDir } = createStackManagementFixture(fixtureDir, 'foreign-source-stack');
    const selectedRepoDir = join(fixtureDir, 'selected-repo');
    await ensureMinimalMonorepoLayout(selectedRepoDir);
    const selectedStackBinDir = join(selectedRepoDir, 'apps', 'stack', 'bin');
    mkdirSync(selectedStackBinDir, { recursive: true });
    writeFileSync(
      join(selectedStackBinDir, 'happier.mjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
      'utf8',
    );
    writeFileSync(
      envPath,
      `HAPPIER_STACK_STACK=${stackName}\nHAPPIER_STACK_REPO_DIR=${selectedRepoDir}\nHAPPIER_STACK_RUNTIME_MODE=source\n`,
      'utf8',
    );
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      stackName,
      'happier',
      'doctor',
      '--json',
    ], { cwd: rootDir, env });

    assert.equal(
      res.code,
      0,
      `selected checkout must own its CLI preparation\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.deepEqual(JSON.parse(res.stdout), ['doctor', '--json']);
    assert.equal(existsSync(syncMarkerPath), false, 'foreign-checkout passthrough must not sync the launcher checkout');
    assert.equal(existsSync(bundleMarkerPath), false, 'foreign-checkout passthrough must not build the launcher checkout');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper keeps dependency-consuming and mutating stack paths behind bundled workspace preflight', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-management-retained-preflight-'));
  try {
    const { bundleMarkerPath, loaderPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { stackName, storageDir } = createStackManagementFixture(fixtureDir);
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const invocations = [
      { args: ['stack', 'runtime', stackName, 'activate', '--json'], label: 'stack runtime activate' },
      { args: ['stack', 'start', stackName, '--source', '--json'], label: 'stack source start' },
      { args: ['stack', 'start', stackName, '--source', '--json', '--', '--runtime'], label: 'stack source start with forwarded runtime flag' },
      { args: ['stack', 'doctor', stackName, '--fix', '--json'], label: 'stack doctor --fix' },
      { args: [stackName, 'happier', 'doctor', '--json'], label: 'launcher-checkout source CLI shorthand' },
    ];

    for (const invocation of invocations) {
      const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), ...invocation.args], { cwd: rootDir, env });
      assert.notEqual(res.code, 0, `${invocation.label} must retain bundled workspace preflight`);
      assert.match(res.stderr, /test bundled workspace preflight is unavailable/, `${invocation.label} must fail at the preflight`);
      assert.equal(existsSync(bundleMarkerPath), true, `${invocation.label} must invoke the bundled workspace fallback`);
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper reports unsupported stack runtime subcommands without publishing workspace packages', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-runtime-unsupported-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { stackName, storageDir } = createStackManagementFixture(fixtureDir);
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'runtime',
      stackName,
      'status',
      '--json',
    ], { cwd: rootDir, env });

    assert.notEqual(res.code, 0);
    assert.equal(JSON.parse(res.stdout).error, 'missing_runtime_subcommand');
    assert.equal(existsSync(syncMarkerPath), false, 'invalid runtime syntax must not enter workspace synchronization');
    assert.equal(existsSync(bundleMarkerPath), false, 'invalid runtime syntax must not enter workspace publication');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper keeps producer snapshot selection out of bundled workspace publication', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-runtime-select-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { envPath, stackName, storageDir } = createStackManagementFixture(fixtureDir);
    writeFileSync(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        'HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=repo-producer',
        '',
      ].join('\n'),
      'utf8',
    );
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'runtime',
      stackName,
      'select',
      '--json',
    ], { cwd: rootDir, env });

    assert.notEqual(res.code, 0, 'selection must fail loudly when its producer has no active snapshot');
    assert.match(res.stderr, /producer repo-producer has no active runtime snapshot/i);
    assert.equal(existsSync(syncMarkerPath), false, 'selection must not synchronize workspace packages');
    assert.equal(existsSync(bundleMarkerPath), false, 'selection must not publish workspace packages');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack runtime snapshot selection help reaches its owner without bundled workspace publication', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-stack-runtime-select-help-'));
  try {
    const { bundleMarkerPath, loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir, {
      failPreflight: true,
      healthResults: [false],
    });
    const { envPath, stackName, storageDir } = createStackManagementFixture(fixtureDir);
    writeFileSync(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        'HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=repo-producer',
        '',
      ].join('\n'),
      'utf8',
    );
    const env = bundledWorkspaceFailureEnv({ fixtureDir, loaderPath, storageDir });
    const res = await runNodeCapture([
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'runtime',
      stackName,
      'select',
      '--help',
    ], { cwd: rootDir, env });

    assert.equal(res.code, 0, `selection help must reach its owner\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stdout, /selects the active complete snapshot already published/i);
    assert.equal(existsSync(syncMarkerPath), false, 'selection help must not synchronize workspace packages');
    assert.equal(existsSync(bundleMarkerPath), false, 'selection help must not publish workspace packages');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack wrapper honors the existing scoped bundled-workspace opt-out for lifecycle cleanup', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-wrapper-bundled-sync-disabled-'));
  try {
    const { loaderPath, syncMarkerPath } = createBundledWorkspaceSyncLoaderFixture(fixtureDir);
    const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'where', '--json'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0',
        HAPPIER_STACK_UPDATE_CHECK: '0',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.equal(
      existsSync(syncMarkerPath),
      false,
      'a cleanup caller that explicitly disables publication must not rebuild workspace bundles',
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
