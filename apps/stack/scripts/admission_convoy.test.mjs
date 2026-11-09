import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { withWorkspaceBundleLock } from '../../../packages/cli-common/workspaceBundleLock.mjs';

test('a head removed before queue observation arms promotes its follower without a catch-up timer fire', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admission-wake-gap-', registerCleanup: false });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const headReady = fixture.path('head-ready');
  const releaseHead = fixture.path('release-head');
  const samplePaused = fixture.path('sample-paused');
  const releaseSample = fixture.path('release-sample');
  const timerFires = fixture.path('timer-fires');
  const probe = fixture.path('clock-observation.cjs');
  await writeFile(timerFires, '');
  // Observe the genuine worker clock; leave every delay and callback intact.
  // This plain follower owns no leases, so its only timer is admission's
  // catch-up when the queue transition happened before observation began.
  await writeFile(probe, `if (process.env.FIXTURE_ROLE === 'follower'
  && process.argv[1]?.endsWith('/workspace_build_admission.mjs')) {
  const { appendFileSync } = require('node:fs');
  const schedule = global.setTimeout;
  global.setTimeout = function(callback, delay, ...args) {
    return schedule(function(...values) {
      appendFileSync(process.env.FIXTURE_TIMER_FIRES, 'fired\\n');
      callback.apply(this, values);
    }, delay, ...args);
  };
}
`);
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
case "$1" in
  */workspace_build_admission.mjs)
    if [ "$FIXTURE_ROLE" = follower ] && [ ! -e "$FIXTURE_SAMPLE_PAUSED" ]; then
      : > "$FIXTURE_SAMPLE_PAUSED"
      while [ ! -e "$FIXTURE_RELEASE_SAMPLE" ]; do sleep 0.02; done
    fi ;;
esac
exec '${process.execPath}' "$@"
` });
  writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = 9 ] && [ "$FIXTURE_ROLE" = head ]; then
  : > "$FIXTURE_HEAD_READY"
  while [ ! -e "$FIXTURE_RELEASE_HEAD" ]; do sleep 0.02; done
fi
exec /usr/bin/flock "$@"
` });
  writeFakeBin({ root: fixture.root, name: 'date', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = +%s ]; then
  if [ "$FIXTURE_ROLE" = head ]; then printf '1\\n'; else printf '2\\n'; fi
else exec /bin/date "$@"; fi
` });
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '37748736 47185920\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = {
    ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${probe}`,
    FIXTURE_HEAD_READY: headReady, FIXTURE_RELEASE_HEAD: releaseHead,
    FIXTURE_SAMPLE_PAUSED: samplePaused, FIXTURE_RELEASE_SAMPLE: releaseSample,
    FIXTURE_TIMER_FIRES: timerFires,
  };
  const running = [];
  const start = role => {
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission',
      ...(role === 'head' ? ['--no-wait'] : []), '--class=validation', '--machine=fixture',
      '--', '/usr/bin/printf', role], { env: { ...env, FIXTURE_ROLE: role } });
    const state = { child, stdout: '', stderr: '', exited: null };
    child.stdout.on('data', chunk => { state.stdout += chunk; });
    child.stderr.on('data', chunk => { state.stderr += chunk; });
    state.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    running.push(state);
    return state;
  };
  const waitForFile = async path => {
    while (true) {
      try { await readFile(path); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  t.after(async () => {
    await Promise.all([writeFile(releaseHead, ''), writeFile(releaseSample, '')]);
    for (const { child } of running) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(running.map(state => state.exited));
    await fixture.cleanup();
  });
  const head = start('head');
  await waitForFile(headReady);
  const follower = start('follower');
  await waitForFile(samplePaused);
  assert.equal((await readdir(admissionRoot)).filter(name => name.startsWith('custody.')).length, 1,
    'the follower has published custody but is paused before its workspace observer starts');
  await writeFile(releaseHead, '');
  assert.equal((await head.exited).code, 0, head.stderr);
  assert.equal(head.stdout, 'head');
  assert.equal((await readdir(`${admissionRoot}/waiters`)).length, 1, 'only the follower remains before its observation starts');
  await writeFile(releaseSample, '');
  assert.equal((await follower.exited).code, 0, follower.stderr);
  assert.equal(follower.stdout, 'follower');
  const fires = (await readFile(timerFires, 'utf8')).trim().split('\n').filter(Boolean).length;
  t.diagnostic(`queue-promotion-catch-up-timer-fires=${fires}`);
  assert.equal(fires, 0, 'a queue transition before observation arms must promote without waiting for the catch-up timer');
  assert.deepEqual(await readdir(`${admissionRoot}/owners`), []);
  assert.deepEqual(await readdir(`${admissionRoot}/waiters`), []);
});

test('a fitting old head admits in one decision despite 200 live same-class followers', { skip: process.platform !== 'linux', timeout: 120_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admission-convoy-', registerCleanup: false });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const ready = fixture.path('published-followers');
  const headReady = fixture.path('head-ready');
  const releaseFollowers = fixture.path('release-followers');
  const releaseHead = fixture.path('release-head');
  const decisions = fixture.path('decisions');
  const samples = fixture.path('resource-samples');
  await mkdir(ready);
  await writeFile(decisions, '');
  await writeFile(samples, '');
  // Count full host observations at the Node process boundary, preserving
  // every observer's real implementation and the real head's payload.
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
case "$1" in
  */service_memory.mjs) printf '%s\\n' "$FIXTURE_ROLE" >> "$FIXTURE_SAMPLES" ;;
esac
exec '${process.execPath}' "$@"
` });
  // Give the already-published head an unambiguous earlier clock observation,
  // independent of second-resolution scheduling or PID wraparound.
  writeFakeBin({ root: fixture.root, name: 'date', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = +%s ]; then
  if [ "$FIXTURE_ROLE" = head ]; then printf '1\\n'; else printf '2\\n'; fi
else
  exec /bin/date "$@"
fi
` });
  // Block after the actual atomic filesystem publication. Every follower has
  // a real, complete, live demand record before any enters admission policy.
  // This is an OS scheduling barrier, not a substitute for queue decisions.
  writeFakeBin({ root: fixture.root, name: 'mv', content: `#!/bin/sh
/bin/mv "$@" || exit "$?"
destination=
for argument do destination=$argument; done
case "$destination" in
  "$FIXTURE_ADMISSION"/waiters/*)
    if [ "$FIXTURE_ROLE" = follower ]; then
      : > "$FIXTURE_READY/$PPID"
      while [ ! -e "$FIXTURE_RELEASE_FOLLOWERS" ]; do sleep 0.1; done
    fi ;;
esac
` });
  // Use the real kernel lock, counting successful acquisitions only. A
  // follower reaching this OS boundary is already the convoy defect: return
  // an injected flock failure after acquisition/release so 200 followers do
  // not each start Node observers merely to establish the same cost failure.
  // The head takes the real lock and executes its complete production path.
  writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = 9 ]; then
  if [ "$FIXTURE_ROLE" = head ]; then
    : > "$FIXTURE_HEAD_READY"
    while [ ! -e "$FIXTURE_RELEASE_HEAD" ]; do sleep 0.1; done
  fi
  /usr/bin/flock "$@" || exit "$?"
  printf '%s\\n' "$FIXTURE_ROLE" >> "$FIXTURE_DECISIONS"
  if [ "$FIXTURE_ROLE" = follower ]; then
    /usr/bin/flock -u 9
    exit 75
  fi
  exit 0
fi
exec /usr/bin/flock "$@"
` });
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '37748736 47185920\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = {
    ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
    FIXTURE_ADMISSION: admissionRoot, FIXTURE_READY: ready,
    FIXTURE_HEAD_READY: headReady, FIXTURE_RELEASE_HEAD: releaseHead,
    FIXTURE_RELEASE_FOLLOWERS: releaseFollowers, FIXTURE_DECISIONS: decisions,
    FIXTURE_SAMPLES: samples,
  };
  const running = [];
  const start = role => {
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
      '--class=validation', '--machine=fixture', '--', '/usr/bin/printf', role], {
      env: { ...env, FIXTURE_ROLE: role },
    });
    const state = { child, stderr: '', stdout: '', exited: null };
    child.stderr.on('data', chunk => { state.stderr += chunk; });
    child.stdout.on('data', chunk => { state.stdout += chunk; });
    state.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    running.push(state);
    return state;
  };
  const waitFor = async (predicate, description) => {
    while (!await predicate()) {
      t.signal.throwIfAborted();
      assert.ok(!running.some(state => state.child.exitCode !== null || state.child.signalCode !== null),
        `${description}: a fixture launcher exited before the barrier`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const exists = path => readFile(path).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  t.after(async () => {
    await Promise.all([writeFile(releaseFollowers, ''), writeFile(releaseHead, '')]);
    for (const { child } of running) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(running.map(state => state.exited));
    await fixture.cleanup();
  });
  const head = start('head');
  await waitFor(() => exists(headReady), 'old head lock entry');
  const followers = Array.from({ length: 200 }, () => start('follower'));
  await waitFor(async () => (await readdir(ready)).length === followers.length, 'all live follower publications');
  assert.equal((await readdir(`${admissionRoot}/owners`)).length, 0);
  assert.equal((await readdir(`${admissionRoot}/waiters`)).length, 201);
  assert.ok(followers.every(({ child }) => child.exitCode === null && child.signalCode === null));
  await writeFile(releaseFollowers, '');
  const followerResults = await Promise.all(followers.map(state => state.exited));
  const beforeHead = (await readFile(decisions, 'utf8')).trim().split('\n').filter(Boolean);
  const samplesBeforeHead = (await readFile(samples, 'utf8')).trim().split('\n').filter(Boolean);
  await writeFile(releaseHead, '');
  const headResult = await head.exited;
  const allDecisions = (await readFile(decisions, 'utf8')).trim().split('\n').filter(Boolean);
  const allSamples = (await readFile(samples, 'utf8')).trim().split('\n').filter(Boolean);
  t.diagnostic(`live-followers=${followers.length} owners-before=0 follower-locks-before-head=${beforeHead.length} total-locks=${allDecisions.length}`);
  t.diagnostic(`follower-resource-observations-before-head=${samplesBeforeHead.length} total-resource-observations=${allSamples.length}`);
  assert.equal(headResult.code, 0, head.stderr);
  assert.equal(head.stdout, 'head', 'the full real head admission reaches its payload');
  assert.equal(samplesBeforeHead.length, 0, 'queue-excluded followers must not start full host resource observations');
  assert.deepEqual(allSamples, ['head'], 'the fitting head requires exactly one full host resource observation');
  assert.equal(beforeHead.length, 0, 'ineligible followers must not acquire the serialized decision lock');
  assert.deepEqual(allDecisions, ['head'], 'the fitting head requires exactly one serialized decision');
  assert.ok(followerResults.every(result => result.code === 75), 'followers decline without a lock failure');
  assert.ok(followers.every(state => state.stdout === ''), 'no follower payload bypasses the head');
});

for (const capacityFalls of [false, true]) {
test(`a workspace-busy retry stays outside the decision mutex until its publication lease becomes available${capacityFalls ? ' or capacity falls' : ''}`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admission-busy-retry-', registerCleanup: false });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const lockPath = fixture.path('package.lock');
  const attempts = fixture.path('decision-attempts');
  const busyCycles = fixture.path('busy-cycles');
  const samples = fixture.path('resource-samples');
  const memory = fixture.path('memory');
  const probe = fixture.path('busy-observation.cjs');
  await Promise.all([writeFile(attempts, ''), writeFile(busyCycles, ''), writeFile(samples, ''), writeFile(memory, '37748736 47185920\n')]);
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
case "$1" in
  */service_memory.mjs) printf 'sample\\n' >> "$FIXTURE_SAMPLES" ;;
esac
exec '${process.execPath}' "$@"
` });
  // Observe completed real lease attempts at the IPC boundary. Every resource
  // decision, observation wake and kernel lock remains the production path.
  await writeFile(probe, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const write = fs.writeSync;
fs.writeSync = function(fd, data, ...args) {
  const result = write.call(this, fd, data, ...args);
  if (fd === 3 && data === 'busy\\n') fs.appendFileSync(process.env.FIXTURE_BUSY_CYCLES, 'busy\\n');
  return result;
};
syncBuiltinESMExports();
`);
  writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = 9 ]; then printf 'attempt\\n' >> "$FIXTURE_DECISION_ATTEMPTS"; fi
exec /usr/bin/flock "$@"
` });
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) exec /bin/cat "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  let releaseForeign;
  let foreignEntered;
  const foreignReady = new Promise(resolve => { foreignEntered = resolve; });
  const foreign = withWorkspaceBundleLock(async () => {
    foreignEntered();
    await new Promise(resolve => { releaseForeign = resolve; });
  }, { lockPath });
  await foreignReady;
  const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=package-dist', '--machine=fixture',
    `--workspace-locks=${JSON.stringify([{ path: lockPath }])}`, '--', '/usr/bin/printf', 'publication-ready'], {
    env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${probe}`,
      FIXTURE_BUSY_CYCLES: busyCycles, FIXTURE_DECISION_ATTEMPTS: attempts, FIXTURE_MEMORY: memory,
      FIXTURE_SAMPLES: samples },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    releaseForeign?.();
    await foreign;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await fixture.cleanup();
  });
  while ((await readFile(busyCycles, 'utf8')).trim().split('\n').filter(Boolean).length < 2) {
    t.signal.throwIfAborted();
    assert.equal(child.exitCode, null, stderr);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const decisionAttempts = (await readFile(attempts, 'utf8')).trim().split('\n').filter(Boolean).length;
  const busySamples = (await readFile(samples, 'utf8')).trim().split('\n').filter(Boolean).length;
  if (capacityFalls) {
    await writeFile(memory, '1048576 47185920\n');
    // The probe-storm brief's option (a) restricts resource observations to
    // eligible decisions. The lease-ready retry must still refuse lost capacity.
    releaseForeign();
    await foreign;
    assert.equal((await exited).code, 75, stderr);
    assert.equal(stdout, '', 'a lease-ready publisher must still refuse newly unachievable capacity');
    assert.match(stderr, /insufficient achievable memory/);
  } else {
    releaseForeign();
    await foreign;
    assert.equal((await exited).code, 0, stderr);
    assert.equal(stdout, 'publication-ready', 'the legitimate publisher resumes through real admission after lease release');
  }
  t.diagnostic(`decision-attempts-during-two-busy-cycles=${decisionAttempts}`);
  t.diagnostic(`resource-observations-during-two-busy-cycles=${busySamples}`);
  assert.equal(decisionAttempts, 1, 'only the initial locked busy publication may enter; unchanged busy retries must not convoy the head');
  assert.equal(busySamples, 1, 'lease-busy retries must not repeat the initial locked host resource observation');
  assert.deepEqual(await readdir(`${admissionRoot}/owners`), []);
  assert.deepEqual(await readdir(`${admissionRoot}/waiters`), []);
});
}

test('a lease-ready oldest waiter regains queue priority without writing outside the decision mutex', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admission-state-lock-', registerCleanup: false });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const lockPath = fixture.path('package.lock');
  const outsideUpdates = fixture.path('outside-updates');
  const releasedCycles = fixture.path('released-cycles');
  const transition = fixture.path('transition');
  const plainAtMutex = fixture.path('plain-at-mutex');
  const allowPlain = fixture.path('allow-plain');
  const probe = fixture.path('pipe-observation.cjs');
  await Promise.all([writeFile(outsideUpdates, ''), writeFile(releasedCycles, '')]);
  // Observe real IPC writes after the foreign lease releases. The production
  // worker still performs every resource operation and writes every byte;
  // this boundary observation only makes its completed retry deterministic.
  await writeFile(probe, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const write = fs.writeSync;
let acquiredAfterTransition = false;
fs.writeSync = function(fd, data, ...args) {
  const result = write.call(this, fd, data, ...args);
  if (process.env.FIXTURE_ROLE === 'batch' && fd === 3 && fs.existsSync(process.env.FIXTURE_TRANSITION)) {
    if (data === 'ready\\n') acquiredAfterTransition = true;
    if (data === 'released\\n' && acquiredAfterTransition) {
      fs.appendFileSync(process.env.FIXTURE_RELEASED_CYCLES, 'released\\n');
      acquiredAfterTransition = false;
    }
  }
  return result;
};
syncBuiltinESMExports();
`);
  writeFakeBin({ root: fixture.root, name: 'mv', content: `#!/bin/sh
destination=
for argument do destination=$argument; done
case "$destination" in
  "$FIXTURE_ADMISSION"/waiters/*)
    if [ -e "$destination" ]; then
      held=0
      while IFS= read -r line; do
        case "$line" in lock:*) held=1 ;; esac
      done < /proc/self/fdinfo/9
      [ "$held" = 1 ] || printf 'outside\\n' >> "$FIXTURE_OUTSIDE_UPDATES"
    fi ;;
esac
exec /bin/mv "$@"
` });
  // The newer arrival has published its demand but cannot take the OS mutex
  // before the older publisher reports that its lease is available again.
  // Queue decisions, resource attempts and publication all stay real.
  writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = 9 ] && [ "$FIXTURE_ROLE" = plain ]; then
  : > "$FIXTURE_PLAIN_AT_MUTEX"
  while [ ! -e "$FIXTURE_ALLOW_PLAIN" ]; do sleep 0.02; done
fi
exec /usr/bin/flock "$@"
` });
  writeFakeBin({ root: fixture.root, name: 'date', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = +%s ]; then
  if [ "$FIXTURE_ROLE" = batch ]; then printf '1\\n'; else printf '2\\n'; fi
else exec /bin/date "$@"; fi
` });
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '37748736 47185920\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = {
    ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${probe}`,
    FIXTURE_ADMISSION: admissionRoot, FIXTURE_OUTSIDE_UPDATES: outsideUpdates,
    FIXTURE_TRANSITION: transition, FIXTURE_RELEASED_CYCLES: releasedCycles,
    FIXTURE_PLAIN_AT_MUTEX: plainAtMutex, FIXTURE_ALLOW_PLAIN: allowPlain,
  };
  const running = [];
  const start = role => {
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=package-dist', '--machine=fixture',
      ...(role === 'batch' ? [`--workspace-locks=${JSON.stringify([{ path: lockPath }])}`] : []),
      '--', '/usr/bin/printf', role], { env: { ...env, FIXTURE_ROLE: role } });
    const state = { child, stdout: '', stderr: '', exited: null };
    child.stdout.on('data', chunk => { state.stdout += chunk; });
    child.stderr.on('data', chunk => { state.stderr += chunk; });
    state.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    running.push(state);
    return state;
  };
  const waitFor = async predicate => {
    while (!await predicate()) {
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  let releaseForeign;
  let foreignEntered;
  const foreignReady = new Promise(resolve => { foreignEntered = resolve; });
  const foreign = withWorkspaceBundleLock(async () => {
    foreignEntered();
    await new Promise(resolve => { releaseForeign = resolve; });
  }, { lockPath });
  let mutex;
  let mutexExited;
  t.after(async () => {
    await writeFile(allowPlain, '');
    releaseForeign?.();
    await foreign;
    if (mutex && !mutex.stdin.writableEnded) mutex.stdin.end('release\n');
    await mutexExited;
    for (const { child } of running) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(running.map(state => state.exited));
    await fixture.cleanup();
  });
  await foreignReady;
  const batch = start('batch');
  await waitFor(() => batch.stderr.includes('workspace-lease-busy'));
  const [batchName] = await readdir(`${admissionRoot}/waiters`);
  const batchPath = `${admissionRoot}/waiters/${batchName}`;
  const before = await readFile(batchPath, 'utf8');
  assert.ok(before.endsWith(' workspace-busy\n'));
  assert.equal(await readFile(outsideUpdates, 'utf8'), '', 'the initial busy update holds the real kernel mutex');
  mutex = spawn('/usr/bin/flock', [`${admissionRoot}/lock`, '/bin/sh', '-c', 'printf ready; read release']);
  let mutexReady = '';
  mutex.stdout.on('data', chunk => { mutexReady += chunk; });
  mutexExited = new Promise(resolve => mutex.once('close', resolve));
  await waitFor(() => mutexReady === 'ready');
  const plain = start('plain');
  await waitFor(async () => (await readdir(`${admissionRoot}/waiters`)).filter(name => !name.startsWith('.')).length === 2);
  await waitFor(async () => { try { await readFile(plainAtMutex); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } });
  await writeFile(transition, '');
  releaseForeign();
  await foreign;
  await waitFor(async () => (await readFile(releasedCycles, 'utf8')).length > 0);
  const updateCount = (await readFile(outsideUpdates, 'utf8')).trim().split('\n').filter(Boolean).length;
  const afterRetry = await readFile(batchPath, 'utf8');
  mutex.stdin.end('release\n');
  await mutexExited;
  // A second released attempt proves the old waiter was excluded again after
  // acquiring its available lease. It must instead become eligible and run
  // while the newer, ready arrival remains at its OS scheduling barrier.
  await waitFor(async () => batch.child.exitCode !== null
    || (await readFile(releasedCycles, 'utf8')).trim().split('\n').filter(Boolean).length >= 2);
  const oldCompletedFirst = batch.child.exitCode === 0;
  await writeFile(allowPlain, '');
  const [batchResult, plainResult] = await Promise.all([batch.exited, plain.exited]);
  assert.equal(batchResult.code, 0, batch.stderr);
  assert.equal(plainResult.code, 0, plain.stderr);
  assert.equal(batch.stdout, 'batch');
  assert.equal(plain.stdout, 'plain');
  t.diagnostic(`outside-mutex-waiter-updates=${updateCount}`);
  assert.equal(updateCount, 0, 'queue-only retries must not race the locked owner when updating waiter state or backfill charge');
  assert.ok(afterRetry === before, 'a released workspace lease cannot rewrite queued state before the decision mutex is acquired');
  assert.equal(oldCompletedFirst, true, 'an older lease-ready publisher must not remain excluded behind newer ready arrivals');
});

test('waiting followers promote on head removal and cancellation retires only its own demand and worker', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admission-promotion-', registerCleanup: false });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const headReady = fixture.path('head-ready');
  const releaseHead = fixture.path('release-head');
  const cancelledWorkers = fixture.path('cancelled-workers');
  await writeFile(cancelledWorkers, '');
  writeFakeBin({ root: fixture.root, name: 'date', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = +%s ]; then
  if [ "$FIXTURE_ROLE" = head ]; then printf '1\\n'; else printf '2\\n'; fi
else exec /bin/date "$@"; fi
` });
  writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = 9 ] && [ "$FIXTURE_ROLE" = head ]; then
  : > "$FIXTURE_HEAD_READY"
  while [ ! -e "$FIXTURE_RELEASE_HEAD" ]; do sleep 0.02; done
fi
exec /usr/bin/flock "$@"
` });
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '37748736 47185920\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  // Observe only the process launch boundary. Queue observation, cancellation,
  // workspace custody, and promotion all retain their production owners.
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
case "$1" in
  */workspace_build_admission.mjs)
    if [ "$FIXTURE_ROLE" = cancel ]; then printf '%s\\n' "$$" >> "$FIXTURE_CANCELLED_WORKERS"; fi ;;
esac
exec '${process.execPath}' "$@"
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = {
    ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '', FIXTURE_HEAD_READY: headReady,
    FIXTURE_RELEASE_HEAD: releaseHead, FIXTURE_CANCELLED_WORKERS: cancelledWorkers,
  };
  const running = [];
  const start = role => {
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission',
      ...(role === 'head' ? ['--no-wait'] : []), '--class=validation', '--machine=fixture',
      '--', '/usr/bin/printf', role], { env: { ...env, FIXTURE_ROLE: role } });
    const state = { child, stdout: '', stderr: '', exited: null };
    child.stdout.on('data', chunk => { state.stdout += chunk; });
    child.stderr.on('data', chunk => { state.stderr += chunk; });
    state.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    running.push(state);
    return state;
  };
  const waitFor = async predicate => {
    while (!await predicate()) {
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const current = pid => {
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  t.after(async () => {
    await writeFile(releaseHead, '');
    for (const { child } of running) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(running.map(state => state.exited));
    await fixture.cleanup();
  });
  const head = start('head');
  await waitFor(() => readFile(headReady).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }));
  const survivor = start('survivor');
  const cancelled = start('cancel');
  await waitFor(() => [survivor, cancelled].every(state => state.stderr.includes('waiting for heavyweight admission')));
  await waitFor(async () => (await readFile(cancelledWorkers, 'utf8')).trim().length > 0);
  assert.equal((await readdir(`${admissionRoot}/owners`)).length, 0);
  assert.equal((await readdir(`${admissionRoot}/waiters`)).length, 3);
  assert.equal(survivor.stdout, '');
  cancelled.child.kill('SIGTERM');
  assert.equal((await cancelled.exited).code, 130, cancelled.stderr);
  const workerPids = (await readFile(cancelledWorkers, 'utf8')).trim().split('\n').map(Number);
  await waitFor(() => workerPids.every(pid => !current(pid)));
  const retainedWaiters = await readdir(`${admissionRoot}/waiters`);
  assert.equal(retainedWaiters.length, 2);
  assert.ok(retainedWaiters.some(name => name.startsWith(`${head.child.pid}-`)));
  assert.ok(retainedWaiters.some(name => name.startsWith(`${survivor.child.pid}-`)));
  assert.ok(!retainedWaiters.some(name => name.startsWith(`${cancelled.child.pid}-`)));
  await writeFile(releaseHead, '');
  const [headResult, survivorResult] = await Promise.all([head.exited, survivor.exited]);
  assert.equal(headResult.code, 0, head.stderr);
  assert.equal(survivorResult.code, 0, survivor.stderr);
  assert.equal(head.stdout, 'head');
  assert.equal(survivor.stdout, 'survivor', 'a waiting follower reaches its payload after the head retires demand');
  assert.equal(cancelled.stdout, '');
  assert.deepEqual(await readdir(`${admissionRoot}/owners`), []);
  assert.deepEqual(await readdir(`${admissionRoot}/waiters`), []);
  assert.deepEqual((await readdir(admissionRoot)).filter(name => name.startsWith('custody.')), []);
});
