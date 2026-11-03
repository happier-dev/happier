import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import * as dependencies from './dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { resolvePnpmCommandInvocation } from '../../../../../scripts/workspaces/execPnpmCommand.mjs';
import { bootstrapRemoteDependencies } from '../dev_targets/remote_dependency_bootstrap.mjs';

const execFileAsync = promisify(execFile);

async function patchedWorkspace(t, { otherPatch = false } = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-patch-relock-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  const { packageManager } = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  const pnpm = async (args, cwd = fixture.root) => {
    const invocation = resolvePnpmCommandInvocation(args, { preferPath: true });
    return await execFileAsync(invocation.command, invocation.args, { cwd, env, signal: t.signal,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  };
  const pristine = fixture.path('pristine');
  await mkdir(pristine);
  await writeFile(join(pristine, 'package.json'), JSON.stringify({ name: 'fixture-patch', version: '1.0.0' }));
  await writeFile(join(pristine, 'value.js'), 'module.exports = "before";\n');
  await pnpm(['pack', '--pack-destination', fixture.root], pristine);
  if (otherPatch) {
    await writeFile(join(pristine, 'package.json'), JSON.stringify({ name: 'fixture-other', version: '1.0.0' }));
    await pnpm(['pack', '--pack-destination', fixture.root], pristine);
  }
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager,
    dependencies: { 'fixture-patch': 'file:./fixture-patch-1.0.0.tgz',
      ...(otherPatch ? { 'fixture-other': 'file:./fixture-other-1.0.0.tgz' } : {}) } }));
  await mkdir(fixture.path('patches'));
  const patch = value => `diff --git a/value.js b/value.js\n--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-module.exports = "before";\n+module.exports = "${value}";\n`;
  const workspace = 'packages: []\npatchedDependencies:\n  fixture-patch@1.0.0: patches/fixture.patch\n'
    + (otherPatch ? '  fixture-other@1.0.0: patches/other.patch\n' : '');
  await writeFile(fixture.path('pnpm-workspace.yaml'), workspace);
  await writeFile(fixture.path('patches/fixture.patch'), patch('first'));
  if (otherPatch) await writeFile(fixture.path('patches/other.patch'), patch('first'));
  await pnpm(['install', '--lockfile-only', '--ignore-scripts', '--offline']);
  const options = { installDir: fixture.root, env, signal: t.signal };
  let installs = 0;
  const install = async ({ env: installEnv }) => {
    installs++;
    assert.equal(dependencies.isDependencyRefreshLockActive(options), true);
    const invocation = resolvePnpmCommandInvocation(['install', '--frozen-lockfile', '--ignore-scripts', '--offline'], { preferPath: true });
    await execFileAsync(invocation.command, invocation.args, { cwd: fixture.root, env: installEnv, signal: t.signal,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  };
  await dependencies.withDependencyRefresh(options, install);
  return { fixture, env, options, install, pnpm, patch, workspace, installs: () => installs };
}

test('patch-hash self-relock installs a changed registered patch and publishes the recovery once', async t => {
  const { fixture, options, install, patch, installs } = await patchedWorkspace(t, { otherPatch: true });
  const oldLock = await readFile(fixture.path('pnpm-lock.yaml'), 'utf8');
  await writeFile(fixture.path('patches/fixture.patch'), patch('second'));
  await writeFile(fixture.path('patches/other.patch'), patch('third'));
  await dependencies.withDependencyRefresh(options, install);
  assert.equal(installs(), 3, 'one failed frozen install and one frozen retry after the baseline');
  assert.match(await readFile(fixture.path('node_modules/fixture-patch/value.js'), 'utf8'), /second/);
  assert.match(await readFile(fixture.path('node_modules/fixture-other/value.js'), 'utf8'), /third/);
  assert.notEqual(await readFile(fixture.path('pnpm-lock.yaml'), 'utf8'), oldLock);
  const publication = await dependencies.readDependencyPublicationState(options);
  assert.deepEqual(publication.patchHashRelock.patches, ['patches/fixture.patch', 'patches/other.patch']);
  assert.equal(typeof publication.patchHashRelock.at, 'string');
  assert.equal(publication.generation, publication.completedGeneration);
  assert.equal((await dependencies.inspectDependencyRefresh(options)).required, false);
  await dependencies.withDependencyRefresh(options, install);
  assert.equal(installs(), 3, 'a recovered installation stays admitted');
});

test('patch-hash self-relock refuses other input drift, invalid patches, and remote writers', async t => {
  for (const scenario of ['version', 'registration', 'registration-path', 'workspace-setting', 'malformed', 'nonapplying', 'nonapplying-second', 'remote', 'remote-bootstrap', 'unadmitted']) {
    await t.test(scenario, async t => {
      const { fixture, options, install, patch, workspace, installs } = await patchedWorkspace(t,
        { otherPatch: scenario === 'nonapplying-second' });
      const oldLock = await readFile(fixture.path('pnpm-lock.yaml'), 'utf8');
      const markerPath = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
      await writeFile(fixture.path('patches/fixture.patch'), patch('second'));
      if (scenario === 'version') {
        const path = fixture.path('package.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.dependencies['fixture-patch'] = '2.0.0';
        await writeFile(path, JSON.stringify(manifest));
      }
      if (scenario === 'registration') await writeFile(fixture.path('pnpm-workspace.yaml'), workspace + '  another@1.0.0: patches/fixture.patch\n');
      if (scenario === 'registration-path') {
        await writeFile(fixture.path('patches/other.patch'), patch('second'));
        await writeFile(fixture.path('pnpm-workspace.yaml'), workspace.replace('patches/fixture.patch', 'patches/other.patch'));
      }
      if (scenario === 'workspace-setting') await writeFile(fixture.path('pnpm-workspace.yaml'), workspace + 'autoInstallPeers: false\n');
      if (scenario === 'malformed') await writeFile(fixture.path('patches/fixture.patch'), 'not a patch\n');
      if (scenario === 'nonapplying') await writeFile(fixture.path('patches/fixture.patch'), patch('second').replace('-module.exports = "before";', '-absent line'));
      if (scenario === 'nonapplying-second') await writeFile(fixture.path('patches/other.patch'), patch('second').replace('-module.exports = "before";', '-absent line'));
      if (scenario === 'unadmitted') await unlink(markerPath);
      const admitted = await readFile(markerPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      await assert.rejects(scenario === 'remote-bootstrap'
        ? bootstrapRemoteDependencies({ repoDir: fixture.root, env: options.env, signal: t.signal,
          executionPlacement: 'remote', validationKind: 'source-test',
          installInitialDependencies: async ({ env }) => install({ env }) })
        : dependencies.withDependencyRefresh(scenario === 'remote'
          ? { ...options, env: { ...options.env, HAPPIER_DEV_TARGET_EXECUTION: '1' } } : options, install),
      { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
      assert.equal(installs(), 2, 'refusals never replay the installer');
      assert.equal(await readFile(fixture.path('pnpm-lock.yaml'), 'utf8'), oldLock, 'refusals never write the lockfile');
      assert.equal(await readFile(markerPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
        admitted, 'refusals preserve readiness evidence');
      const publication = await dependencies.readDependencyPublicationState(options);
      assert.notEqual(publication.generation, publication.completedGeneration);
    });
  }
});

test('patch-hash self-relock refuses a specifier edited while the failed frozen install settles', async t => {
  const { fixture, options, install, patch } = await patchedWorkspace(t);
  const lockfile = await readFile(fixture.path('pnpm-lock.yaml'), 'utf8');
  await writeFile(fixture.path('patches/fixture.patch'), patch('second'));
  await assert.rejects(dependencies.withDependencyRefresh(options, async context => {
    try { await install(context); }
    catch (error) {
      // Model a source edit concurrent with the actual pnpm process boundary.
      const path = fixture.path('package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.dependencies['fixture-patch'] = 'file:fixture-patch-1.0.0.tgz';
      await writeFile(path, JSON.stringify(manifest));
      throw error;
    }
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(await readFile(fixture.path('pnpm-lock.yaml'), 'utf8'), lockfile,
    'source edits after the initial refresh snapshot cannot authorize unrelated relocking');
});

test('patch-hash self-relock retains recovery evidence when its only frozen retry fails', async t => {
  const { fixture, options, install, patch, installs } = await patchedWorkspace(t);
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const admitted = await readFile(marker, 'utf8');
  await writeFile(fixture.path('patches/fixture.patch'), patch('second'));
  await assert.rejects(dependencies.withDependencyRefresh(options, async context => {
    await install(context);
    throw Object.assign(new Error('frozen retry failed'), { code: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' });
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(installs(), 3, 'recovery makes only one frozen retry');
  assert.equal(await readFile(marker, 'utf8'), admitted);
  const publication = await dependencies.readDependencyPublicationState(options);
  assert.deepEqual(publication.patchHashRelock.patches, ['patches/fixture.patch']);
  assert.notEqual(publication.generation, publication.completedGeneration);
});

test('patch-hash self-relock refuses a source edit during pnpm patch validation', async t => {
  const { fixture, options, install, patch } = await patchedWorkspace(t);
  const lockfile = await readFile(fixture.path('pnpm-lock.yaml'), 'utf8');
  await writeFile(fixture.path('patches/fixture.patch'), patch('second'));
  const invocation = resolvePnpmCommandInvocation([], { preferPath: true });
  const wrapper = fixture.path('mutating-pnpm.cjs');
  // This OS/process-boundary wrapper retains real pinned pnpm validation and
  // deterministically models an edit arriving while that child is running.
  await writeFile(wrapper, `const {spawnSync}=require('node:child_process');
const {readFileSync,writeFileSync}=require('node:fs');
const args=process.argv.slice(2);
const result=spawnSync(${JSON.stringify(invocation.command)},[...${JSON.stringify(invocation.args)},...args],{stdio:'inherit',windowsVerbatimArguments:${Boolean(invocation.windowsVerbatimArguments)}});
if(result.error) throw result.error;
if(args[0]==='patch' && result.status===0) {
 const path=${JSON.stringify(fixture.path('package.json'))};
 const manifest=JSON.parse(readFileSync(path,'utf8'));
 manifest.dependencies['fixture-patch']='file:fixture-patch-1.0.0.tgz';
 writeFileSync(path,JSON.stringify(manifest));
}
process.exit(result.status ?? 1);
`);
  await assert.rejects(dependencies.withDependencyRefresh({ ...options,
    env: { ...options.env, npm_execpath: wrapper } }, install), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(await readFile(fixture.path('pnpm-lock.yaml'), 'utf8'), lockfile);
});
