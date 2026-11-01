import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';
import { createTestTempDirectory } from './process/temporaryDirectories.mjs';
import { assertTestHomePath, createTestHomeEnvironment, resolveTestHomeEnvironment } from './testHomeEnvironment.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configs = [
  'apps/cli/vitest.config.ts',
  'apps/cli/vitest.integration.config.ts',
  'apps/cli/vitest.slow.config.ts',
  'apps/cli/vitest.x1.config.ts',
  'apps/server/vitest.config.ts',
  'apps/server/vitest.integration.config.ts',
  'apps/server/vitest.dbcontract.config.ts',
  'apps/server/vitest.externalSessionMaterialize.integration.config.ts',
  'packages/cli-common/vitest.config.ts',
  'apps/ui/vitest.config.ts',
  'apps/server/vitest.ui.integration.config.ts',
];

test('an isolated user Home can be the native process working directory', () => {
  const home = createTestHomeEnvironment();
  try {
    assertTestHomePath(home.env.HOME, home.env.HAPPIER_TEST_HOME_ROOT);
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: home.env.HOME, env: { ...process.env, ...home.env }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(resolve(result.stdout), resolve(home.env.HOME));
  } finally {
    home.cleanup();
  }
});

test('package harnesses isolate even a configuration import before worker setup', async () => {
  const sentinel = createTestTempDirectory('happier-home-sentinel-');
  const before = { ...process.env };
  try {
    for (const config of configs) {
      process.env.HAPPIER_HOME_DIR = sentinel.root;
      const ctx = await createVitest('test', {
        config: resolve(repoRoot, config), root: dirname(resolve(repoRoot, config)),
        watch: false, include: [],
      }, { resolve: { alias: [{ find: /^@\//u, replacement: `${resolve(repoRoot, 'apps/cli/src')}/` }] } });
      try {
        // Vitest installs config.env before loading setup-file dependencies.
        // Deliberately capture configuration before any worker setup/reload.
        Object.assign(process.env, ctx.config.env);
        const { configuration } = await ctx.vite.ssrLoadModule(resolve(repoRoot, 'apps/cli/src/configuration.ts'));
        assertTestHomePath(configuration.happyHomeDir);
        writeFileSync(join(configuration.happyHomeDir, 'fixture-write'), 'disposable fixture', { flag: 'wx' });
        assert.deepEqual(readdirSync(sentinel.root).filter(name => name !== '.happier-test-temp-owner'), [], config);
        assert.notEqual(configuration.happyHomeDir, sentinel.root, config);
        if (config === 'apps/cli/vitest.config.ts') {
          process.env.HAPPIER_TEST_HOME_ROOT = join(configuration.happyHomeDir, 'different-root');
          await assert.rejects(ctx.vite.ssrLoadModule(resolve(repoRoot, 'apps/cli/src/vitestHomeGuard.ts')), /escaped its disposable/);
        }
      } finally {
        await ctx.close();
      }
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    sentinel.cleanup();
  }
});

test('an isolated Home keeps the browsers the runner installed for Playwright', () => {
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
  try {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HOME = join(repoRoot, 'runner-user');
    process.env.USERPROFILE = process.env.HOME;
    const first = resolveTestHomeEnvironment(join(repoRoot, 'temporary'));
    assert.match(first.PLAYWRIGHT_BROWSERS_PATH, /ms-playwright$/u);
    assert.ok(first.PLAYWRIGHT_BROWSERS_PATH.includes('runner-user') || process.platform === 'win32');
    assert.ok(!first.PLAYWRIGHT_BROWSERS_PATH.includes('temporary'));
    // A worker resolving again from the isolated Home keeps the same location.
    process.env.PLAYWRIGHT_BROWSERS_PATH = first.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HOME = first.HOME;
    assert.equal(resolveTestHomeEnvironment(join(repoRoot, 'temporary-2')).PLAYWRIGHT_BROWSERS_PATH, first.PLAYWRIGHT_BROWSERS_PATH);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Home guard refuses escaped and sibling-prefix paths', () => {
  assert.doesNotThrow(() => assertTestHomePath(join(repoRoot, 'temporary', 'cli'), join(repoRoot, 'temporary')));
  assert.throws(() => assertTestHomePath(join(repoRoot, 'temporary-other', 'cli'), join(repoRoot, 'temporary')), /escaped/);
  assert.throws(() => assertTestHomePath(repoRoot, join(repoRoot, 'temporary')), /escaped/);
  assert.throws(() => assertTestHomePath(repoRoot, ''), /escaped/);
});

test('native cli-common lane isolates Home before importing its persistence owner', () => {
  const sentinel = createTestTempDirectory('happier-native-home-sentinel-');
  const packageRoot = resolve(repoRoot, 'packages/cli-common');
  const command = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).scripts['test:dist:local'].split(/\s+/u);
  const nodeOptions = command.slice(1, command.indexOf('--test'));
  try {
    const result = spawnSync(process.execPath, [...nodeOptions, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import { join, relative } from 'node:path';
      import { homedir } from 'node:os';
      import { assertTestHomePath } from '../../scripts/testing/testHomeEnvironment.mjs';
      import { resolveFirstPartyInstallLayout, resolvePersonalHomeRuntimeLayout } from './dist/firstPartyRuntime/index.js';
      const captured = resolveFirstPartyInstallLayout({ componentId: 'happier-cli' });
      assert.ok(process.env.HAPPIER_TEST_HOME_ROOT, 'native test lane inherited the ambient Happier Home');
      assert.equal(relative(process.env.HAPPIER_TEST_HOME_ROOT, captured.happyHomeDir), 'cli');
      assert.equal(relative(process.env.HAPPIER_TEST_HOME_ROOT, homedir()), 'user', 'default user Home escaped isolation');
      const explicitHome = join(process.env.HAPPIER_TEST_HOME_ROOT, 'explicit-user');
      const personalHome = resolvePersonalHomeRuntimeLayout({ homeDir: explicitHome, platform: process.platform, mode: 'user', channel: 'stable' });
      assertTestHomePath(personalHome.configDir, explicitHome);
      assertTestHomePath(personalHome.installRoot, explicitHome);
      assertTestHomePath(personalHome.logsDir, explicitHome);
      writeFileSync(join(captured.happyHomeDir, 'native-fixture'), 'disposable fixture', { flag: 'wx' });
    `], {
      cwd: packageRoot,
      env: { ...process.env, HAPPIER_HOME_DIR: sentinel.root, HAPPIER_TEST_HOME_ROOT: '',
        HAPPIER_SELF_HOST_INSTALL_ROOT: join(sentinel.root, 'install'),
        HAPPIER_SELF_HOST_CONFIG_DIR: join(sentinel.root, 'config'),
        HAPPIER_SELF_HOST_LOG_DIR: join(sentinel.root, 'logs') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(sentinel.root).filter(name => name !== '.happier-test-temp-owner'), []);
  } finally { sentinel.cleanup(); }
});
