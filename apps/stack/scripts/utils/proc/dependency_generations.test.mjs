// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import * as dependencies from './dependency_refresh.mjs';
import { moveInPlaceInstallationIntoGeneration, readCurrentDependencyGeneration } from './dependency_generations.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

// The package manager is the process boundary: this fake installs like pnpm
// does in place (remove a package, then write its files one by one). Locking,
// generations, switching and retention are the real owners.
async function fakeInstall(dir, version, { pause } = {}) {
  for (const [modules, name] of [['node_modules', 'dep'], [join('packages', 'a', 'node_modules'), 'dep2']]) {
    const packageDir = join(dir, modules, name);
    await rm(packageDir, { recursive: true, force: true });
    await mkdir(packageDir, { recursive: true });
    await pause?.();
    await writeFile(join(packageDir, 'index.js'), `module.exports = ${JSON.stringify(version)};\n`);
  }
  // pnpm links workspace packages relative to the directory it installed in.
  await rm(join(dir, 'node_modules', 'a'), { force: true });
  await symlink(join('..', 'packages', 'a'), join(dir, 'node_modules', 'a'));
}

async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dependency-generations-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  const installDir = fixture.path('repo');
  await mkdir(join(installDir, 'packages', 'a', 'src'), { recursive: true });
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0' }));
  await writeFile(join(installDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(join(installDir, 'pnpm-lock.yaml'), '# v1\n');
  await writeFile(join(installDir, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }));
  await dependencies.withDependencyRefresh({ installDir, env }, () => fakeInstall(installDir, 'v1'));
  return { fixture, env, installDir };
}

const readInstalled = installDir => [
  readFileSync(join(installDir, 'node_modules', 'dep', 'index.js'), 'utf8'),
  readFileSync(join(installDir, 'packages', 'a', 'node_modules', 'dep2', 'index.js'), 'utf8'),
];

test('readers keep resolving, without waiting, while a generation-managed tree installs and switches', async t => {
  const { env, installDir } = await setup(t);
  await moveInPlaceInstallationIntoGeneration(installDir);
  await writeFile(join(installDir, 'pnpm-lock.yaml'), '# v2\n');
  let installing = true;
  const failures = [];
  let custodyReads = 0;
  let plainReads = 0;
  // A long process that loads lazily holds no custody at all.
  const plainReader = (async () => {
    while (installing) {
      try { readInstalled(installDir); plainReads += 1; } catch (error) { failures.push(`plain ${error.code}`); }
      await delay(1);
    }
  })();
  // Short readers take custody only while resolving.
  const custodyReader = (async () => {
    while (installing) {
      try {
        await dependencies.withDependencyConsumption({ installDir, env }, async () => { readInstalled(installDir); });
        if (installing) custodyReads += 1;
      } catch (error) { failures.push(`custody ${error.code ?? error.message}`); }
      await delay(1);
    }
  })();
  const result = await dependencies.withDependencyRefresh({ installDir, env, generationInstall: true },
    async ({ installCwd = installDir, publishInstallation }) => {
      await fakeInstall(installCwd, 'v2', { pause: () => delay(200) });
      await publishInstallation?.();
    });
  installing = false;
  await Promise.all([plainReader, custodyReader]);
  assert.equal(result.refreshed, true);
  assert.deepEqual(failures, [], 'no read may miss an installed file');
  assert.ok(plainReads > 0);
  assert.ok(custodyReads > 0, 'a custody reader must not wait for the installer');
  assert.deepEqual(readInstalled(installDir), ['module.exports = "v2";\n', 'module.exports = "v2";\n']);
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir, env })).required, false);
  // Workspace links reach the real project, including files created after the install.
  await mkdir(join(installDir, 'packages', 'a', 'dist'));
  await writeFile(join(installDir, 'packages', 'a', 'dist', 'later.js'), '');
  assert.equal(await realpath(join(installDir, 'node_modules', 'a', 'dist', 'later.js')),
    await realpath(join(installDir, 'packages', 'a', 'dist', 'later.js')));
});

test('the replaced generation stays while a reader that entered before the switch holds it, then goes', async t => {
  const { env, installDir } = await setup(t);
  const first = (await moveInPlaceInstallationIntoGeneration(installDir)).name;
  const container = join(installDir, '.happier', 'deps', 'node_modules');
  await writeFile(join(installDir, 'pnpm-lock.yaml'), '# v2\n');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  const reader = dependencies.withDependencyConsumption({ installDir, env }, async () => { entered(); await held; });
  await inside;
  await dependencies.withDependencyRefresh({ installDir, env, generationInstall: true },
    async ({ installCwd = installDir, publishInstallation }) => { await fakeInstall(installCwd, 'v2'); await publishInstallation?.(); });
  const second = readCurrentDependencyGeneration(installDir);
  assert.notEqual(second, first);
  assert.deepEqual((await readdir(container)).sort(), [first, second].sort(), 'the reader still holds the first generation');
  release();
  await reader;
  assert.deepEqual(await readdir(container), [second], 'its last reader removes the replaced generation');
});

test('a failed generation install leaves the live tree and its admission untouched', async t => {
  const { env, installDir } = await setup(t);
  const first = (await moveInPlaceInstallationIntoGeneration(installDir)).name;
  await writeFile(join(installDir, 'pnpm-lock.yaml'), '# v2\n');
  await assert.rejects(dependencies.withDependencyRefresh({ installDir, env, generationInstall: true },
    async ({ installCwd = installDir }) => {
      await fakeInstall(installCwd, 'broken');
      throw Object.assign(new Error('ERR_PNPM_OUTDATED_LOCKFILE'), { code: 'ERR_PNPM_OUTDATED_LOCKFILE' });
    }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(readCurrentDependencyGeneration(installDir), first);
  assert.deepEqual(readInstalled(installDir), ['module.exports = "v1";\n', 'module.exports = "v1";\n']);
  assert.deepEqual(await readdir(join(installDir, '.happier', 'deps', 'node_modules')), [first]);
  // Readers still enter; consumers do not retry the same failed inputs.
  await dependencies.withDependencyConsumption({ installDir, env }, async () => { readInstalled(installDir); });
  const readiness = await dependencies.inspectDependencyRefresh({ installDir, env });
  assert.equal(readiness.failedInstallIdentity, readiness.installIdentity);
  assert.equal(existsSync(join(installDir, 'node_modules')), true);
});

test('a Stack running on the checkout keeps the replaced generation until it exits', async t => {
  const { fixture, env: baseEnv, installDir } = await setup(t);
  const first = (await moveInPlaceInstallationIntoGeneration(installDir)).name;
  const container = join(installDir, '.happier', 'deps', 'node_modules');
  // A running Stack on this checkout (a server or daemon that loads lazily) holds no
  // dependency custody; its process is the boundary, so a real idle child stands in.
  const stackProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => stackProcess.kill());
  const stacks = fixture.path('stacks');
  await mkdir(join(stacks, 'dev'), { recursive: true });
  await writeFile(join(stacks, 'dev', 'env'), `HAPPIER_STACK_REPO_DIR=${installDir}\n`);
  await writeFile(join(stacks, 'dev', 'stack.runtime.json'), JSON.stringify({ ownerPid: stackProcess.pid }));
  const env = { ...baseEnv, HAPPIER_STACK_STORAGE_DIR: stacks, HAPPIER_STACK_ENV_FILE: '', HAPPIER_STACK_STACK: '' };
  await writeFile(join(installDir, 'pnpm-lock.yaml'), '# v2\n');
  await dependencies.withDependencyRefresh({ installDir, env, generationInstall: true },
    async ({ installCwd = installDir, publishInstallation }) => { await fakeInstall(installCwd, 'v2'); await publishInstallation?.(); });
  const second = readCurrentDependencyGeneration(installDir);
  assert.deepEqual((await readdir(container)).sort(), [first, second].sort(), 'the running Stack still holds the first generation');
  stackProcess.kill();
  await once(stackProcess, 'exit');
  // The next reader to finish releases what nothing holds any more.
  await dependencies.withDependencyConsumption({ installDir, env }, async () => { readInstalled(installDir); });
  assert.deepEqual(await readdir(container), [second]);
});
