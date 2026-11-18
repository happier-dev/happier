import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { createAdmissionBroker } from '../../apps/stack/scripts/utils/proc/admission_broker.mjs';
import { runAdmittedTask } from '../../apps/stack/scripts/utils/proc/admission_client.mjs';
import { buildNativeAdmissionFixtureEnv } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

const setupPath = fileURLToPath(new URL('./setup-pnpm.mjs', import.meta.url));

async function fixture(t, { corrupt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = 'fixture package archive';
  const digest = createHash('sha512').update(corrupt ? 'other archive' : payload).digest('hex');
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: `pnpm@12.14.0+sha512.${digest}` }));
  // npm and pnpm are external process boundaries. The archive contents need not
  // be an npm package: this test protects admission before the real npm install.
  const npmPath = join(root, 'npm-cli.js');
  await writeFile(npmPath, `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.SETUP_TEST_CALLS, JSON.stringify(args) + '\\n');
    if (process.env.SETUP_TEST_ADMISSIONS) fs.appendFileSync(process.env.SETUP_TEST_ADMISSIONS, JSON.stringify({ admitted: Boolean(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT) }) + '\\n');
    if (args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      const filename = 'pnpm-12.14.0.tgz';
      fs.writeFileSync(path.join(destination, filename), ${JSON.stringify(payload)});
      console.log(JSON.stringify([{ filename }]));
    } else if (args[0] === 'install') {
      if (process.env.SETUP_TEST_LIVE_PREREQUISITE) fs.rmSync(process.env.SETUP_TEST_LIVE_PREREQUISITE, { force: true });
      fs.writeFileSync(process.env.SETUP_TEST_INSTALLED, 'ready');
    }
    else process.exit(2);
  `);
  const pnpmPath = join(root, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  await writeFile(pnpmPath, process.platform === 'win32'
    ? '@echo off\r\nif not exist "%SETUP_TEST_INSTALLED%" exit /b 1\r\necho 12.14.0\r\n'
    : '#!/bin/sh\n[ -f "$SETUP_TEST_INSTALLED" ] || exit 1\nprintf "12.14.0\\n"\n');
  await chmod(pnpmPath, 0o755);
  return { root, env: { ...process.env, npm_execpath: npmPath, PATH: `${root}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    PNPM_HOME: join(root, 'pnpm-home'), HAPPIER_STACK_HOME_DIR: root, SETUP_TEST_CALLS: join(root, 'calls'), SETUP_TEST_INSTALLED: join(root, 'installed') } };
}

test('setup installs the exact integrity-checked root pin without Corepack', async (t) => {
  const { root, env } = await fixture(t);
  execFileSync(process.execPath, [setupPath, root], { env });
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls[0].includes('pnpm@12.14.0'));
  assert.ok(calls[0].includes('--ignore-scripts'));
  assert.equal(calls[1][0], 'install');
  assert.ok(calls[1].includes('--global'));
  assert.match(calls[1].at(-1), /pnpm-12\.14\.0\.tgz$/);
});

test('setup rejects a mismatched archive before global installation', async (t) => {
  const { root, env } = await fixture(t, { corrupt: true });
  assert.throws(() => execFileSync(process.execPath, [setupPath, root], { env, stdio: 'pipe' }), /integrity mismatch/);
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(([command]) => command), ['pack']);
});

test('repeated setup reuses a live matching package manager without another archive download', async t => {
  const { root, env } = await fixture(t);
  env.SETUP_TEST_LIVE_PREREQUISITE = join(root, 'live-node-gyp');
  execFileSync(process.execPath, [setupPath, root], { env });
  await writeFile(env.SETUP_TEST_LIVE_PREREQUISITE, 'in-use native build payload');
  execFileSync(process.execPath, [setupPath, root], { env });
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(([command]) => command === 'pack').length, 1,
    'a warm preparation must not download an archive it will not install');
  assert.equal(calls.filter(([command]) => command === 'install').length, 1);
  assert.equal(await readFile(env.SETUP_TEST_LIVE_PREREQUISITE, 'utf8'), 'in-use native build payload',
    'setup must preserve the matching package manager payload used by dependency scripts');
});


test('cold setup waits for joint host capacity before downloading or installing, while warm setup needs none',
  { skip: process.platform !== 'linux' }, async t => {
    const { root, env: inheritedEnv } = await fixture(t);
    const { root: admissionRoot } = await createTempFixture(t, { parentDir: '/tmp', prefix: 'hps-' });
    const broker = createAdmissionBroker({ root: admissionRoot, oldLockPath: join(root, 'old.lock'),
      readCpuCapacity: () => 1,
      sampleResources: async () => ({ availableMemoryKiB: 64 * 1024 * 1024, totalMemoryKiB: 64 * 1024 * 1024 }) });
    await broker.start();
    const acquired = Promise.withResolvers();
    const release = Promise.withResolvers();
    const env = { ...buildNativeAdmissionFixtureEnv(inheritedEnv),
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: admissionRoot, HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: 'fixture',
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '', SETUP_TEST_ADMISSIONS: join(root, 'admissions') };
    const holder = runAdmittedTask({ root: admissionRoot, machine: 'fixture', className: 'validation',
      floorKiB: 1, repoDir: root, env }, async () => { acquired.resolve(); await release.promise; });
    let child;
    let closed;
    t.after(async () => {
      release.resolve();
      await holder;
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
      await broker.close();
    });
    await acquired.promise;
    const queued = Promise.withResolvers();
    child = spawn(process.execPath, [setupPath, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = once(child, 'close');
    child.stderr.on('data', value => { if (String(value).includes('waiting for admission')) queued.resolve(); });
    await Promise.race([queued.promise, closed.then(() => assert.fail('cold bootstrap must wait for capacity before launching archive or installer work'))]);
    await assert.rejects(readFile(join(root, 'calls')), { code: 'ENOENT' });
    release.resolve();
    await holder;
    assert.deepEqual(await closed, [0, null]);
    const admissions = (await readFile(join(root, 'admissions'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(admissions, [{ admitted: true }, { admitted: true }]);
    execFileSync(process.execPath, [setupPath, root], {
      env: { ...env, HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: join(root, 'unavailable-admission') }, stdio: 'pipe' });
    assert.equal((await readFile(join(root, 'admissions'), 'utf8')).trim().split('\n').length, 2);
  });

// A fresh CI checkout runs setup before any install: no installed package
// (third-party or workspace) can resolve. The hook models that loader boundary.
const noInstalledPackagesHook = `data:text/javascript,${encodeURIComponent(`
  import { isBuiltin, registerHooks } from 'node:module';
  registerHooks({ resolve(specifier, context, next) {
    const result = isBuiltin(specifier) || /^(\\.{0,2}\\/|file:|#)/.test(specifier) ? next(specifier, context) : null;
    if (!result || result.url.includes('/node_modules/')) {
      throw Object.assign(new Error('Cannot find package ' + specifier + ' imported from ' + context.parentURL), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return result;
  } });
`)}`;

test('cold full-checkout setup, including host admission, runs before any package is installed', async t => {
  const { root, env: inheritedEnv } = await fixture(t);
  let env = { ...inheritedEnv, NODE_OPTIONS: '' };
  if (process.platform === 'linux') {
    const { root: admissionRoot } = await createTempFixture(t, { parentDir: '/tmp', prefix: 'hps-' });
    const broker = createAdmissionBroker({ root: admissionRoot, oldLockPath: join(root, 'old.lock'),
      readCpuCapacity: () => 1,
      sampleResources: async () => ({ availableMemoryKiB: 64 * 1024 * 1024, totalMemoryKiB: 64 * 1024 * 1024 }) });
    await broker.start();
    t.after(() => broker.close());
    env = { ...buildNativeAdmissionFixtureEnv(env), NODE_OPTIONS: '',
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: admissionRoot, HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: 'fixture',
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '' };
  }
  // Asynchronous: the fixture broker answers admission from this process's event loop.
  const child = spawn(process.execPath, ['--import', noInstalledPackagesHook, setupPath, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  assert.deepEqual(await once(child, 'close'), [0, null], stderr);
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(([command]) => command), ['pack', 'install']);
});

// These are the setup-time source COPY inputs shared by all three Docker deps
// stages. Deliberately omit apps/stack: it is copied only after pnpm install.
async function dockerSetupPath(root) {
  for (const relative of [
    'scripts/ci/setup-pnpm.mjs',
    'scripts/workspaces',
    'packages/cli-common/windowsCommandInvocation.mjs',
  ]) {
    const destination = join(root, relative);
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(new URL(`../../${relative}`, import.meta.url), destination, { recursive: true });
  }
  return join(root, 'scripts/ci/setup-pnpm.mjs');
}

test('Darwin setup completes an active pnpm switch while leaving an unpublished stage alone',
  { skip: process.platform !== 'darwin' }, async t => {
    const { root, env } = await fixture(t);
    const imageSetup = await dockerSetupPath(root);
    await writeFile(env.SETUP_TEST_INSTALLED, 'ready');

    const tools = join(env.PNPM_HOME, '.tools', 'pnpm');
    const stage = join(tools, '12.14.0_tmp_active');
    const wrapper = join(stage, 'node_modules', 'pnpm');
    const published = join(tools, '12.14.0', 'bin', 'pnpm');
    const unpublished = join(tools, '12.14.0_tmp_unpublished', 'bin');
    const placeholder = "# pnpm's native binary replaces this file during installation\nexit 71\n";
    await mkdir(wrapper, { recursive: true });
    await mkdir(join(stage, 'bin'));
    await mkdir(unpublished, { recursive: true });
    await writeFile(join(wrapper, 'package.json'), JSON.stringify({ name: 'pnpm', version: '12.14.0' }));
    await writeFile(join(wrapper, 'pnpm'), placeholder, { mode: 0o755 });
    await writeFile(join(unpublished, 'pnpm'), placeholder, { mode: 0o755 });
    await symlink('../node_modules/pnpm/pnpm', join(stage, 'bin', 'pnpm'));
    await symlink('12.14.0_tmp_active', join(tools, '12.14.0'));
    // Boundary stand-in for the upstream installer, which atomically replaces
    // the placeholder using the already-installed native dependency.
    await writeFile(join(wrapper, 'install.js'), `
      const fs = require('node:fs');
      const bin = __dirname + '/pnpm';
      fs.writeFileSync(bin + '.pnpm-tmp', '#!/bin/sh\\nprintf "12.14.0\\\\n"\\n', { mode: 0o755 });
      fs.renameSync(bin + '.pnpm-tmp', bin);
    `);

    assert.throws(() => execFileSync(published, ['--version'], { stdio: 'pipe' }), { code: 'ENOEXEC' });
    execFileSync(process.execPath, [imageSetup, root], { env, stdio: 'pipe' });
    assert.equal(execFileSync(published, ['--version'], { encoding: 'utf8' }).trim(), '12.14.0');
    assert.equal(await readFile(join(unpublished, 'pnpm'), 'utf8'), placeholder);
    await assert.rejects(readFile(env.SETUP_TEST_CALLS), { code: 'ENOENT' });
  });

test('Docker deps-stage files support cold and warm integrity-pinned setup without host tooling', async t => {
  const { root, env } = await fixture(t);
  const imageSetup = await dockerSetupPath(root);
  execFileSync(process.execPath, [imageSetup, root], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [imageSetup, root], { env, stdio: 'pipe' });
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(([command]) => command), ['pack', 'install']);
  assert.ok(calls[0].includes('pnpm@12.14.0'));
  assert.ok(calls[1].includes('--global'));
  assert.equal(await readFile(join(root, 'installed'), 'utf8'), 'ready');
});

test('Docker deps-stage setup rejects an archive that does not match the root integrity pin', async t => {
  const { root, env } = await fixture(t, { corrupt: true });
  const imageSetup = await dockerSetupPath(root);
  assert.throws(() => execFileSync(process.execPath, [imageSetup, root], { env, stdio: 'pipe' }), /integrity mismatch/);
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(([command]) => command), ['pack']);
});
