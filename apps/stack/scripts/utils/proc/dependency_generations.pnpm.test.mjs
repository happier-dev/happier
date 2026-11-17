// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { resolvePnpmCommandInvocation } from '../../../../../scripts/workspaces/execPnpmCommand.mjs';
import * as dependencies from './dependency_refresh.mjs';
import { readCurrentDependencyGeneration } from './dependency_generations.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

// Real pnpm (the checkout's own version and hoisted linker) against an adopted
// tree. Its only dependencies are local directories, so no registry is used.
// pnpm 12 keeps task-run state in the root `node_modules` and refuses `pnpm run`
// and `pnpm exec` when that directory is a link (P03-ATOMIC-SWITCH, nl3).
const rootPackage = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'));

function pnpmArgs(args, cwd, env) {
  const invocation = resolvePnpmCommandInvocation(args, { preferPath: true });
  return [invocation.command, invocation.args, { cwd, env, encoding: 'utf8', windowsVerbatimArguments: invocation.windowsVerbatimArguments }];
}

function pnpm(args, cwd, env) {
  const result = spawnSync(...pnpmArgs(args, cwd, env));
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(`pnpm ${args.join(' ')} failed: ${result.stderr || result.stdout}`), { code: 'PNPM_FAILED' });
  return result.stdout.trim();
}

const pnpmAsync = async (args, cwd, env) => (await promisify(execFile)(...pnpmArgs(args, cwd, env))).stdout;

const script = 'node -e "console.log(require(\'dep\'))"';
const rootManifest = version => JSON.stringify({ name: 'root', private: true, packageManager: rootPackage.packageManager,
  scripts: { hello: script }, devDependencies: { dep: `file:vendor/dep-v${version}` } });

async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dependency-generations-pnpm-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  const installDir = fixture.path('repo');
  const write = async (path, text) => { await mkdir(join(installDir, path, '..'), { recursive: true }); await writeFile(join(installDir, path), text); };
  for (const version of [1, 2, 3]) {
    await write(`vendor/dep-v${version}/package.json`, JSON.stringify({ name: 'dep', version: `${version}.0.0`, main: 'index.js', bin: { 'dep-bin': 'bin.js' } }));
    await write(`vendor/dep-v${version}/index.js`, `module.exports = 'v${version}';\n`);
    await write(`vendor/dep-v${version}/bin.js`, `#!/usr/bin/env node\nconsole.log('bin v${version}');\n`);
  }
  await write('package.json', rootManifest(1));
  await write('pnpm-workspace.yaml', 'packages:\n  - packages/*\nnodeLinker: hoisted\nverifyDepsBeforeRun: false\n');
  // A conflicting version makes the project keep its own node_modules.
  await write('packages/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0', scripts: { hello: script },
    dependencies: { dep: 'file:../../vendor/dep-v2' } }));
  // The committed lockfile precedes the admitted install, as in the checkout.
  pnpm(['install', '--lockfile-only', '--offline', '--reporter=silent'], installDir, env);
  await dependencies.withDependencyRefresh({ installDir, env }, async () => { pnpm(['install', '--frozen-lockfile', '--offline', '--reporter=silent'], installDir, env); });
  return { env, installDir, write };
}

const read = installDir => [join(installDir, 'node_modules', 'dep', 'index.js'), join(installDir, 'packages', 'a', 'node_modules', 'dep', 'index.js')]
  .map(path => readFileSync(path, 'utf8').trim());

function assertPnpmWorks(installDir, env, rootVersion) {
  assert.equal(pnpm(['run', '-s', 'hello'], installDir, env), rootVersion);
  assert.equal(pnpm(['--filter', 'a', 'run', '-s', 'hello'], installDir, env), 'v2');
  assert.equal(pnpm(['exec', 'dep-bin'], installDir, env), `bin ${rootVersion}`);
  assert.equal(pnpm(['exec', 'dep-bin'], join(installDir, 'packages', 'a'), env), 'bin v2');
}

const refreshWithPnpm = ({ installDir, env }) => dependencies.withDependencyRefresh({ installDir, env, generationInstall: true },
  async ({ env: installEnv, installCwd, publishInstallation }) => {
    assert.ok(installCwd && installCwd !== installDir, 'a generation-managed tree installs beside the live one');
    await pnpmAsync(['install', '--frozen-lockfile', '--offline', '--reporter=silent'], installCwd, installEnv);
    await publishInstallation();
  });

test('an adopted tree keeps pnpm run and exec working, and readers resolve through a real pnpm generation switch', async t => {
  const { env, installDir, write } = await setup(t);
  await mkdir(join(installDir, 'node_modules', '.cache', 'tool'), { recursive: true });
  await dependencies.adoptDependencyGenerations({ installDir, env });
  assert.equal(lstatSync(join(installDir, 'node_modules')).isDirectory(), true, 'the root node_modules stays a real directory');
  assertPnpmWorks(installDir, env, 'v1');

  await write('package.json', rootManifest(3));
  pnpm(['install', '--lockfile-only', '--offline', '--reporter=silent'], installDir, env);
  const before = readCurrentDependencyGeneration(installDir);
  let refreshing = true;
  const failures = [];
  let reads = 0;
  const reader = (async () => {
    while (refreshing) {
      try { read(installDir); reads += 1; } catch (error) { failures.push(error.code ?? error.message); }
      await delay(1);
    }
  })();
  const result = await refreshWithPnpm({ installDir, env });
  refreshing = false;
  await reader;
  assert.equal(result.refreshed, true);
  assert.deepEqual(failures, [], 'no read during the refresh may miss an installed file');
  assert.ok(reads > 0);
  assert.notEqual(readCurrentDependencyGeneration(installDir), before);
  assert.deepEqual(read(installDir), ["module.exports = 'v3';", "module.exports = 'v2';"]);
  assertPnpmWorks(installDir, env, 'v3');
  assert.equal(existsSync(join(installDir, 'node_modules', '.cache', 'tool')), true, 'checkout state in node_modules survives a switch');
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir, env })).required, false);
});

test('a failed real pnpm install leaves the live tree untouched', async t => {
  const { env, installDir, write } = await setup(t);
  await dependencies.adoptDependencyGenerations({ installDir, env });
  const live = readCurrentDependencyGeneration(installDir);
  // A manifest edit without its lockfile: the frozen install refuses.
  await write('package.json', rootManifest(3));
  await assert.rejects(refreshWithPnpm({ installDir, env }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(readCurrentDependencyGeneration(installDir), live);
  assert.deepEqual(await readdir(join(installDir, '.happier', 'deps', 'node_modules')), [live]);
  assert.deepEqual(read(installDir), ["module.exports = 'v1';", "module.exports = 'v2';"]);
  assertPnpmWorks(installDir, env, 'v1');
});

test('the replaced real pnpm generation is released once the reader that entered before the switch finishes', async t => {
  const { env, installDir, write } = await setup(t);
  await dependencies.adoptDependencyGenerations({ installDir, env });
  const first = readCurrentDependencyGeneration(installDir);
  await write('package.json', rootManifest(3));
  pnpm(['install', '--lockfile-only', '--offline', '--reporter=silent'], installDir, env);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  const reader = dependencies.withDependencyConsumption({ installDir, env }, async () => { entered(); await held; });
  await inside;
  await refreshWithPnpm({ installDir, env });
  const second = readCurrentDependencyGeneration(installDir);
  const container = join(installDir, '.happier', 'deps', 'node_modules');
  assert.deepEqual((await readdir(container)).sort(), [first, second].sort(), 'the reader still holds the first generation');
  release();
  await reader;
  assert.deepEqual(await readdir(container), [second], 'its last reader releases the replaced generation');
  assertPnpmWorks(installDir, env, 'v3');
});

test('a switch replaces what a plain in-place pnpm install wrote into an adopted tree', async t => {
  const { env, installDir, write } = await setup(t);
  await dependencies.adoptDependencyGenerations({ installDir, env });
  // A hand-run install writes real entries over the generation links.
  pnpm(['install', '--offline', '--reporter=silent'], installDir, env);
  await write('package.json', rootManifest(3));
  pnpm(['install', '--lockfile-only', '--offline', '--reporter=silent'], installDir, env);
  await refreshWithPnpm({ installDir, env });
  assert.equal(lstatSync(join(installDir, 'node_modules', 'dep')).isSymbolicLink(), true);
  assert.equal(lstatSync(join(installDir, 'packages', 'a', 'node_modules')).isSymbolicLink(), true);
  assert.deepEqual(read(installDir), ["module.exports = 'v3';", "module.exports = 'v2';"]);
  assertPnpmWorks(installDir, env, 'v3');
});
