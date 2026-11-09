import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';

const GiB = 1024 * 1024;
async function until(condition, diagnostic) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(diagnostic());
}

async function capacityFixture(t, availableGiB) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-unfittable-head-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  const processMemoryKiBPath = fixture.path('worker-pages.json');
  await writeFile(observedPidsPath, '[]');
  await writeFile(processMemoryKiBPath, '{}');
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath, processMemoryKiBPath });
  const memory = fixture.path('memory');
  const setAvailable = value => writeFile(memory, `${value * GiB} ${26 * GiB}\n`);
  await setAvailable(availableGiB);
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '%s\\n' "$FIXTURE_OBSERVATION_CLASS" >> "$FIXTURE_OBSERVATIONS"; /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root: fixture.root, name: 'sleep', content: '#!/bin/sh\nexec /bin/sleep 0.02\n' });
  const observations = fixture.path('observations');
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_MEMORY: memory, FIXTURE_OBSERVATIONS: observations,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '' };
  const start = (className, command = ['/usr/bin/printf', 'payload'], noWait = false) => {
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', `--class=${className}`,
      '--failure-id=capacity-test', '--machine=fixture', ...(noWait ? ['--no-wait'] : []), '--', ...command], { env: { ...env, FIXTURE_OBSERVATION_CLASS: className } });
    let stdout = '', stderr = '', settled = false;
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const exited = new Promise(resolve => child.once('close', (status, signal) => { settled = true; resolve({ status, signal }); }));
    t.after(async () => { if (!settled) child.kill('SIGTERM'); await exited; });
    return { child, exited, stdout: () => stdout, stderr: () => stderr, settled: () => settled,
      diagnostic: () => JSON.stringify({ className, settled, status: child.exitCode, signal: child.signalCode, stdout, stderr }) };
  };
  const entries = async kind => readdir(`${admissionRoot}/${kind}`).then(names => names.filter(name => !name.startsWith('.'))).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return { ...fixture, admissionRoot, observedPidsPath, processMemoryKiBPath, start, setAvailable, entries, observations };
}

test('unfittable 20 GiB head on a 26 GiB worker with 11 GiB unmanaged usage releases followers', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  const fixture = await capacityFixture(t, 15);
  await mkdir(fixture.admissionRoot, { recursive: true });
  // Freeze the real decision mutex, publish both requests and reproduce the
  // incident's already-spent backfill envelope before either can decide.
  const mutex = spawn('/usr/bin/flock', [`${fixture.admissionRoot}/lock`, '/bin/sh', '-c', 'printf ready; read release']);
  let mutexReady = false;
  mutex.stdout.once('data', () => { mutexReady = true; });
  const mutexExited = new Promise(resolve => mutex.once('exit', resolve));
  t.after(async () => { if (!mutex.stdin.writableEnded) mutex.stdin.end('release\n'); await mutexExited; });
  await until(() => mutexReady, () => 'fixture decision mutex did not acquire');
  const head = fixture.start('compilation-ui');
  await until(async () => (await fixture.entries('waiters')).length === 1, head.stderr);
  const [headName] = await fixture.entries('waiters');
  const headPath = `${fixture.admissionRoot}/waiters/${headName}`;
  const fields = (await readFile(headPath, 'utf8')).trim().split(/\s+/u);
  fields[4] = String(20 * GiB);
  await writeFile(headPath, fields.join(' ') + '\n');
  const follower = fixture.start('validation');
  await until(async () => (await fixture.entries('waiters')).length === 2, follower.stderr);
  mutex.stdin.end('release\n');
  await mutexExited;
  await until(head.settled, () => `unfittable head did not settle: ${head.stderr()}`);
  assert.deepEqual(await head.exited, { status: 75, signal: null }, head.stderr());
  assert.match(head.stderr(), /^HSTACK_ADMISSION_CAPACITY:capacity-test$/m);
  assert.match(head.stderr(), /achievable-memory=15728640\/27262976.*requires=20971520/);
  assert.equal(head.stdout(), '');
  assert.deepEqual(await follower.exited, { status: 0, signal: null }, follower.stderr());
  assert.equal(follower.stdout(), 'payload');
  assert.deepEqual(await fixture.entries('waiters'), []);
  const observations = (await readFile(fixture.observations, 'utf8')).trim().split('\n');
  assert.equal(observations.filter(className => className === 'compilation-ui').length, 1,
    'an infeasible head settles after one physical-memory observation without capacity re-polling');
  assert.ok(observations.includes('validation'), 'the admitted follower still observes current capacity');
});

test('head waits for admitted resident pages, then admits when that owner releases them', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  const fixture = await capacityFixture(t, 24);
  const owner = fixture.start('validation', ['/bin/sh', '-c', 'printf owned; read release']);
  await until(() => owner.stdout() === 'owned', owner.diagnostic);
  await writeFile(fixture.observedPidsPath, JSON.stringify([owner.child.pid]));
  await writeFile(fixture.processMemoryKiBPath, JSON.stringify({ [owner.child.pid]: 11 * GiB }));
  await fixture.setAvailable(10);
  const head = fixture.start('compilation-ui');
  await until(() => head.stderr().includes('waiting for heavyweight admission'), head.diagnostic);
  assert.equal(head.settled(), false, head.stderr());
  assert.doesNotMatch(head.stderr(), /HSTACK_ADMISSION_CAPACITY/);
  await fixture.setAvailable(21);
  owner.child.stdin.end('release\n');
  assert.deepEqual(await owner.exited, { status: 0, signal: null }, owner.stderr());
  assert.deepEqual(await head.exited, { status: 0, signal: null }, head.stderr());
  assert.equal(head.stdout(), 'payload');
  assert.deepEqual(await fixture.entries('waiters'), []);
});

test('fixture admitted memory releases after its temporary directory cleanup', { skip: process.platform !== 'linux', timeout: 10_000 }, async t => {
  const fixture = await capacityFixture(t, 15);
  const pressure = await holdNativeAdmissionFixtureMemory(t, fixture, { totalKiB: 26 * GiB, availableKiB: 15 * GiB });
  await rm(fixture.root, { recursive: true, force: true });
  await pressure.release();
  assert.equal(pressure.child.exitCode, 0);
});

test('an already queued unsatisfiable head permits a fitting backfill before visibly refusing', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  const fixture = await capacityFixture(t, 24);
  const owner = fixture.start('validation', ['/bin/sh', '-c', 'printf owned; read release']);
  await until(() => owner.stdout() === 'owned', owner.diagnostic);
  await writeFile(fixture.observedPidsPath, JSON.stringify([owner.child.pid]));
  await writeFile(fixture.processMemoryKiBPath, JSON.stringify({ [owner.child.pid]: 6 * GiB }));
  await fixture.setAvailable(15);
  const head = fixture.start('compilation-ui');
  await until(() => head.stderr().includes('waiting for heavyweight admission'), head.diagnostic);
  // Pause only this fixture's queued process at the OS boundary. Its admitted
  // owner drains, but unmanaged usage now keeps available memory at 15 GiB.
  head.child.kill('SIGSTOP');
  t.after(() => { head.child.kill('SIGCONT'); });
  await until(async () => /\) T /.test(await readFile(`/proc/${head.child.pid}/stat`, 'utf8')), head.stderr);
  owner.child.stdin.end('release\n');
  assert.deepEqual(await owner.exited, { status: 0, signal: null }, owner.stderr());
  await writeFile(fixture.observedPidsPath, '[]');
  await writeFile(fixture.processMemoryKiBPath, '{}');
  assert.equal((await fixture.entries('owners')).length, 0);
  const follower = fixture.start('validation', undefined, true);
  const followerResult = await follower.exited;
  head.child.kill('SIGCONT');
  assert.deepEqual(followerResult, { status: 0, signal: null }, follower.stderr());
  assert.equal(follower.stdout(), 'payload');
  assert.deepEqual(await head.exited, { status: 75, signal: null }, head.stderr());
  assert.match(head.stderr(), /^HSTACK_ADMISSION_CAPACITY:capacity-test$/m);
  assert.deepEqual(await fixture.entries('waiters'), []);
});
