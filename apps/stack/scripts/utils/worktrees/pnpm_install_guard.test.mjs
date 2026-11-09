import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { assertDependenciesReady, inspectDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { run } from '../proc/proc.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { shouldRunPnpmInstall, withPnpmInstallGuard } from './pnpm_install_guard.mjs';

async function touch(path, ms) {
  const d = new Date(ms);
  await utimes(path, d, d);
}

test('workspace install guard restores UI patch and asset bytes before publishing dependency readiness', {
  skip: process.platform === 'win32' ? 'fake package-manager executable uses a POSIX shebang' : false,
}, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-pnpm-ui-postinstall-' });
  for (const component of ['cli', 'server', 'ui']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), JSON.stringify({ name: `@fixture/${component}` }));
  }
  const uiDir = join(root, 'apps', 'ui');
  await mkdir(join(uiDir, 'patches'), { recursive: true });
  await mkdir(join(uiDir, 'tools'), { recursive: true });
  await copyFile(new URL('../../../../ui/tools/resolveUiPostinstallTasks.mjs', import.meta.url),
    join(uiDir, 'tools/resolveUiPostinstallTasks.mjs'));
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/app', scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
    happier: { installFreshnessInputs: ['patches', 'tools'] },
  }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# workspace fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - \"apps/*\"\n");
  const patchPath = join(uiDir, 'patches', 'markdown.patch');
  const workerSource = join(uiDir, 'tools', 'worker.js');
  const patchedOutput = join(uiDir, 'node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
  const workerOutput = join(uiDir, 'public', 'worker.js');
  await writeFile(patchPath, 'first patch\n');
  await writeFile(workerSource, 'first worker\n');

  // Pnpm is the process boundary. It re-extracts dependency bytes but reuses
  // lifecycle admission; the real guard and UI preparation owners remain live.
  const { binDir } = writeFakeBin({ root, name: 'pnpm', content: `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'install') {
  fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
  fs.mkdirSync(path.dirname(${JSON.stringify(patchedOutput)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(patchedOutput)}, 'pristine dependency\\n');
} else if (args.join(' ') === '--filter @happier-dev/app run --silent postinstall:real') {
  if (!fs.existsSync(${JSON.stringify(join(root, '.project', 'tmp', 'dependency-install.lock'))})) process.exit(44);
  if (process.env.HAPPIER_TEST_UI_POSTINSTALL_FAIL === '1') process.exit(43);
  fs.copyFileSync(${JSON.stringify(patchPath)}, ${JSON.stringify(patchedOutput)});
  fs.mkdirSync(path.dirname(${JSON.stringify(workerOutput)}), { recursive: true });
  fs.copyFileSync(${JSON.stringify(workerSource)}, ${JSON.stringify(workerOutput)});
} else process.exit(42);
` });
  const env = buildStackHarnessEnv({ binDirs: [binDir], baseEnv: buildStackFixtureEnv({
    stripStackEnv: true, homeDir: join(root, 'home'),
    extraEnv: { HAPPIER_STACK_STACKS_DIR: join(root, 'stacks'), HAPPIER_STACK_ENV_FILE: '', npm_execpath: '' },
  }) });
  const install = (extraEnv = {}) => withPnpmInstallGuard({
    installDir: root, componentDir: root, quiet: true, env: { ...env, ...extraEnv },
  }, () => run('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env, stdio: 'ignore' }));

  await install();
  assert.equal(await readFile(patchedOutput, 'utf8'), 'first patch\n');
  assert.equal(await readFile(workerOutput, 'utf8'), 'first worker\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  assert.equal((await install()).refreshed, false);
  await unlink(patchedOutput);
  assert.equal((await install()).refreshed, false);
  assert.equal(await readFile(patchedOutput, 'utf8'), 'first patch\n',
    'a warm installed tree repairs missing UI outputs without reinstalling dependencies');

  await writeFile(patchPath, 'changed patch\n');
  await writeFile(workerSource, 'changed worker\n');
  await install();
  assert.equal(await readFile(patchedOutput, 'utf8'), 'changed patch\n');
  assert.equal(await readFile(workerOutput, 'utf8'), 'changed worker\n');

  await writeFile(workerSource, 'recovered worker\n');
  await assert.rejects(install({ HAPPIER_TEST_UI_POSTINSTALL_FAIL: '1' }));
  await assert.rejects(assertDependenciesReady({ installDir: root, env }),
    { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH', reason: 'stale-or-unadmitted' });
  await install();
  assert.equal(await readFile(workerOutput, 'utf8'), 'recovered worker\n');
});

test('guarded installs keep first-party workspace builds out of the dependency writer lock', {
  skip: process.platform === 'win32' ? 'fake package-manager executable uses a POSIX shebang' : false,
}, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-pnpm-install-scope-' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# workspace fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - \"packages/*\"\n");
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const gatePath = join(repoRoot, 'scripts', 'postinstall', 'shouldRunPostinstall.cjs');
  const dependencyRefreshUrl = new URL('../proc/dependency_refresh.mjs', import.meta.url).href;

  const buildOutput = join(root, 'explicit-postinstall-output');
  // Pnpm is the process boundary. The real lifecycle gate excludes first-party
  // builds by default, while an explicit scope permits its requested output.
  const { binDir } = writeFakeBin({ root, name: 'pnpm', content: `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] !== 'install') process.exit(42);
fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
const gate = require(${JSON.stringify(gatePath)});
if (!gate.shouldRunPostinstall({ workspace: 'protocol', scope: process.env.HAPPIER_INSTALL_SCOPE || '' })) process.exit(0);
import(${JSON.stringify(dependencyRefreshUrl)})
  .then(({ resolveDependencyRefreshLockPath }) => {
    if (!fs.existsSync(resolveDependencyRefreshLockPath(process.cwd(), process.env))) throw new Error('missing active dependency writer');
    fs.writeFileSync(${JSON.stringify(buildOutput)}, 'explicit lifecycle output');
  })
  .then(() => process.exit(0), () => process.exit(45));
` });
  const env = buildStackHarnessEnv({ binDirs: [binDir], baseEnv: buildStackFixtureEnv({
    stripStackEnv: true, homeDir: join(root, 'home'),
    extraEnv: { HAPPIER_STACK_STACKS_DIR: join(root, 'stacks'), HAPPIER_STACK_ENV_FILE: '', npm_execpath: '' },
  }) });
  delete env.HAPPIER_INSTALL_SCOPE;
  const install = (scopeEnv) => withPnpmInstallGuard({ installDir: root, componentDir: root, quiet: true, env: { ...env, ...scopeEnv } },
    ({ env: installEnv }) => run('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env: installEnv, stdio: 'ignore' }));

  assert.equal((await install({})).refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  await assert.rejects(stat(buildOutput), { code: 'ENOENT' });

  // An explicitly permitted lifecycle runs under the existing install writer.
  await writeFile(join(root, 'pnpm-lock.yaml'), '# changed workspace fixture\n');
  assert.equal((await install({ HAPPIER_INSTALL_SCOPE: 'protocol' })).refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  assert.equal(await readFile(buildOutput, 'utf8'), 'explicit lifecycle output');
});

test('shouldRunPnpmInstall returns true when node_modules is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-lock.yaml'), '#\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n");

  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
});

test('shouldRunPnpmInstall bootstraps the canonical snapshot even when legacy integrity is newer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-lock.yaml'), '#\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n");
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.modules.yaml'), 'x\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'package.json'), base - 10_000);
  await touch(join(dir, 'pnpm-lock.yaml'), base - 9_000);
  await touch(join(dir, 'node_modules', '.modules.yaml'), base);

  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
});

test('dependency readiness survives replacement of node_modules by the admitted refresh', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-persistent-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n");
  await mkdir(join(dir, 'node_modules'), { recursive: true });

  let refreshes = 0;
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
    await rm(join(dir, 'node_modules'), { recursive: true, force: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
  });

  const inspection = await inspectDependencyRefresh({ installDir: dir, componentDir: dir });
  assert.equal(inspection.markerPath.startsWith(join(dir, 'node_modules')), true);
  assert.equal(inspection.required, false);
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 1);
});

test('dependency refresh records its captured inputs and the next demand refreshes changed inputs once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-successor-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n");
  await mkdir(join(dir, 'node_modules'), { recursive: true });

  let refreshes = 0;
  const initial = await inspectDependencyRefresh({ installDir: dir, componentDir: dir });
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
    await writeFile(join(dir, 'pnpm-lock.yaml'), '# changed while installing\n', 'utf-8');
  });

  const superseded = await inspectDependencyRefresh({ installDir: dir, componentDir: dir });
  assert.equal(superseded.required, true);
  const marker = JSON.parse(await readFile(superseded.markerPath, 'utf-8'));
  assert.equal(marker.identity, initial.installIdentity);

  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
  });
  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), false);
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 2);
});

test('dependency freshness ignores timestamp-only changes but detects same-size content changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-content-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const packagePath = join(dir, 'package.json');
  await writeFile(packagePath, '{"dependencies":{"example":"1.0.0"}}\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n");
  await mkdir(join(dir, 'node_modules'), { recursive: true });

  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
  };
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  const originalStats = await stat(packagePath);
  await touch(packagePath, originalStats.mtimeMs + 60_000);
  assert.equal(
    await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }),
    false,
    'a sync-only timestamp change must not reinstall unchanged dependencies',
  );

  await writeFile(packagePath, '{"dependencies":{"example":"1.0.1"}}\n', 'utf-8');
  await touch(packagePath, originalStats.mtimeMs + 60_000);
  assert.equal((await stat(packagePath)).size, originalStats.size);
  assert.equal(
    await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }),
    true,
    'same-size dependency input changes must invalidate the installed tree',
  );
  assert.equal(refreshes, 1);
});

test('shouldRunPnpmInstall returns true when pnpm-lock.yaml is newer than integrity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-lock.yaml'), '#\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n");
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.modules.yaml'), 'x\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'node_modules', '.modules.yaml'), base - 10_000);
  await touch(join(dir, 'pnpm-lock.yaml'), base);

  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
});

test('shouldRunPnpmInstall returns true when patches are newer than integrity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-lock.yaml'), '#\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n");
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.modules.yaml'), 'x\n', 'utf-8');
  await mkdir(join(dir, 'patches'), { recursive: true });
  await writeFile(join(dir, 'patches', 'a.patch'), 'diff\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'node_modules', '.modules.yaml'), base - 10_000);
  await touch(join(dir, 'patches', 'a.patch'), base);

  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
});

test('canonical guard detects registered patch additions, changes, and deletions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-pnpm-guard-declared-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  await writeFile(
    join(dir, 'package.json'),
    '{}\n',
    'utf-8',
  );
  await writeFile(join(dir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\npatchedDependencies:\n  example@1.0.0: install-inputs/a.patch\n  example@2.0.0: install-inputs/b.patch\n");
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.modules.yaml'), 'old\n', 'utf-8');
  const input = join(dir, 'install-inputs', 'a.patch');

  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  await Promise.all([
    withPnpmInstallGuard({ installDir: dir, componentDir: dir }, refresh),
    withPnpmInstallGuard({ installDir: dir, componentDir: dir }, refresh),
  ]);
  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), false);

  await mkdir(join(dir, 'install-inputs'), { recursive: true });
  await writeFile(input, 'a\n', 'utf-8');
  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  const added = join(dir, 'install-inputs', 'b.patch');
  await writeFile(added, 'b\n', 'utf-8');
  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  await writeFile(input, 'changed-size\n', 'utf-8');
  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  await unlink(added);
  assert.equal(await shouldRunPnpmInstall({ installDir: dir, componentDir: dir }), true);
  await withPnpmInstallGuard({ installDir: dir, componentDir: dir }, refresh);
  assert.equal(refreshes, 5);
});
