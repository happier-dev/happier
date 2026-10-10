import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import { terminateProcessTreeByPid } from '../../../scripts/testing/process/processTree.mjs';

const sourceRoot = resolve(import.meta.dirname, '../../..');

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.fail(message);
}

function completedChild(child, stderr) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal, stderr: stderr.value }));
  });
}

test('workspace dist builder acquires heavyweight admission before its real dist lock', {
  skip: process.platform !== 'linux',
  timeout: 30_000,
}, async t => {
  const children = [];
  t.after(async () => {
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null)
      .map(child => terminateProcessTreeByPid(child.pid, { graceMs: 1_000 })));
  });
  const fixture = await createTempFixture(t, { prefix: 'hstack-workspace-dist-admission-' });
  const checkout = fixture.path('native-owner');
  await mkdir(join(checkout, 'scripts'), { recursive: true });
  await cp(join(sourceRoot, 'scripts/workspaces'), join(checkout, 'scripts/workspaces'), { recursive: true });
  await mkdir(join(checkout, 'packages'), { recursive: true });
  await symlink(join(sourceRoot, 'packages/cli-common'), join(checkout, 'packages/cli-common'), 'dir');
  await symlink(join(sourceRoot, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  await mkdir(join(checkout, 'apps/stack/scripts'), { recursive: true });
  await cp(join(sourceRoot, 'apps/stack/scripts/utils'), join(checkout, 'apps/stack/scripts/utils'), { recursive: true });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });

  const packageDir = fixture.path('package');
  await mkdir(join(packageDir, 'src'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/workspace-dist-admission',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
  }));
  await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
      rootDir: 'src', outDir: 'dist', declaration: true, strict: true,
    },
    include: ['src/**/*.ts'],
  }));
  await writeFile(join(packageDir, 'src/index.ts'), 'export const admitted = true;\n');

  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, {
    name: '@happier-dev/workspace-dist-admission',
  });
  const ready = fixture.path('payload-ready');
  const go = fixture.path('payload-go');
  const acquired = fixture.path('payload-acquired');
  const blocked = fixture.path('payload-blocked');
  const payload = fixture.path('payload.mjs');
  await writeFile(payload, `
import { access, writeFile } from 'node:fs/promises';
import { withWorkspaceBundleLock } from ${JSON.stringify(new URL('../../../scripts/workspaces/workspaceBundleLock.mjs', import.meta.url).href)};
await writeFile(process.env.READY, 'ready');
while (true) {
  try { await access(process.env.GO); break; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}
try {
  await withWorkspaceBundleLock(async () => {
    await writeFile(process.env.ACQUIRED, 'acquired');
  }, { lockPath: process.env.DIST_LOCK, timeoutMs: 750, pollIntervalMs: 20, staleAfterMs: 30_000 });
} catch (error) {
  await writeFile(process.env.BLOCKED, String(error?.code ?? error));
}
`);

  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '33554432 33554432\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = {
    ...process.env,
    PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_PREFERRED_EXECUTION: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
    HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_HSTACK_DISPATCH_CONTROL: '',
    HAPPIER_HSTACK_EXECUTION: '',
    READY: ready,
    GO: go,
    ACQUIRED: acquired,
    BLOCKED: blocked,
    DIST_LOCK: lockPath,
  };

  const payloadStderr = { value: '' };
  const payloadChild = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=compilation', '--machine=worker', '--', process.execPath, payload], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(payloadChild);
  payloadChild.stderr.on('data', chunk => { payloadStderr.value += chunk; });
  const payloadDone = completedChild(payloadChild, payloadStderr);
  await waitFor(async () => access(ready).then(() => true, () => false), 'admitted payload did not start');

  const builderStderr = { value: '' };
  const builder = join(checkout, 'scripts/workspaces/buildTypeScriptPackageDist.mjs');
  const builderChild = spawn(process.execPath, [builder, '-p', 'tsconfig.json'], {
    cwd: packageDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(builderChild);
  builderChild.stderr.on('data', chunk => { builderStderr.value += chunk; });
  const builderDone = completedChild(builderChild, builderStderr);

  await waitFor(async () => {
    if (builderChild.exitCode !== null || builderChild.signalCode !== null) {
      assert.fail(`builder exited before admission: ${builderStderr.value}`);
    }
    const staged = (await readdir(packageDir)).some(name => name.startsWith('.dist.build.'));
    const waiters = await readdir(join(admissionRoot, 'waiters')).catch(() => []);
    return staged || waiters.length > 0;
  }, 'builder neither entered admission nor began lock-owned staging');
  await writeFile(go, 'go');

  const [payloadResult, builderResult] = await Promise.all([payloadDone, builderDone]);
  assert.equal(payloadResult.code, 0, `${payloadResult.signal ?? ''} ${payloadResult.stderr}`);
  assert.equal(builderResult.code, 0, `${builderResult.signal ?? ''} ${builderResult.stderr}`);
  assert.equal(await readFile(acquired, 'utf8'), 'acquired',
    `payload could not finish through the dist lock while it owned admission: ${await readFile(blocked, 'utf8').catch(() => '')}`);
  await assert.rejects(access(blocked), { code: 'ENOENT' });
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /admitted/);
  assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
});
