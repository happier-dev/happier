import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { readLinuxWorkerProcesses } from './utils/proc/service_memory.mjs';

async function waitForAdmissionDecision(child, readStderr) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (readStderr().includes('waiting for heavyweight admission')) return;
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`waiter exited before deciding: ${readStderr()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.fail(`waiter did not decide admission: ${readStderr()}`);
}

test('controller VM and Darwin admissions observe their shared physical CPU pressure', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-shared-cpu-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  const sourceRoot = join(fixture.root, 'native-owner');
  const stackDir = fixture.path('stacks/repo-native');
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    `projection_repo_root='${sourceRoot}'`, "target_count='1'", "target_1_name='mac-host'",
    "target_1_ssh='fixture-host'", "target_1_ssh_config=''",
  ].join('\n'));
  const load = fixture.path('host-load');
  await writeFile(load, '18 41\n');
  writeFakeBin({ root: fixture.root, name: 'ssh', content: '#!/bin/sh\n[ "${HOST_OBSERVABLE-1}" = 1 ] || exit 255\ncat "$FIXTURE_HOST_LOAD"\n' });
  writeFakeBin({ root: fixture.root, name: 'uname', content: '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_PLATFORM"\n' });
  writeFakeBin({ root: fixture.root, name: 'sysctl', content: '#!/bin/sh\ncase "$*" in *hw.ncpu*) printf "18\\n" ;; *vm.loadavg*) read cpu load < "$FIXTURE_HOST_LOAD"; printf "{ %s 0 0 }\\n" "$load" ;; esac\n' });
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '48000000 73400320\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), FIXTURE_HOST_LOAD: load,
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const run = (platform, machine = 'local', extra = {}) => spawnSync('/bin/sh', [launcher,
    '--heavyweight-admission', '--class=validation', `--machine=${machine}`, '--no-wait', '--', '/usr/bin/printf', 'started',
  ], { env: { ...env, FIXTURE_PLATFORM: platform, ...extra }, encoding: 'utf8' });
  for (const platform of ['Linux', 'Darwin']) {
    const blocked = run(platform);
    assert.equal(blocked.status, 75, `${platform}: ${blocked.stderr}`);
    assert.equal(blocked.stdout, '');
    assert.match(blocked.stderr, /host-cpu-load=41\/18/);
  }
  assert.equal(run('Linux', 'worker', { HAPPIER_DEV_TARGET_EXECUTION: '1' }).status, 0);
  assert.equal(run('Linux', 'local', { HOST_OBSERVABLE: '0' }).status, 0, 'unobservable host pressure does not fabricate a denial');
  await writeFile(load, '18 10\n');
  for (const platform of ['Linux', 'Darwin']) {
    const quiet = run(platform);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout, 'started');
  }
});

test('local heavyweight admission protects the browser memory floor without raising worker envelopes', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-local-memory-floor-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  const memory = fixture.path('memory');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, CI: '',
    FIXTURE_MEMORY: memory, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const run = (machine, check = false, extraEnv = {}) => spawnSync('/bin/sh', [launcher,
    check ? '--heavyweight-admission-check' : '--heavyweight-admission', '--class=validation', `--machine=${machine}`,
    ...(check ? [] : ['--no-wait', '--', '/usr/bin/printf', 'started']),
  ], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  // The controller has 70 GiB total: just below 8 GiB passes both the old
  // 6 GiB validation envelope and the old 10% ratio, but pauses browsers.
  await writeFile(memory, '8388607 73400320\n');
  const blocked = run('local');
  assert.equal(blocked.status, 75, blocked.stderr);
  assert.equal(blocked.stdout, '');
  const check = run('local', true);
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stderr, /requires=8388608 KiB/);
  assert.equal(run('worker').status, 0, 'workers retain the measured class envelope');
  assert.equal(run('local', false, { HAPPIER_DEV_TARGET_EXECUTION: '1' }).status, 0, 'already placed workers retain worker admission');
  await writeFile(memory, '8388608 73400320\n');
  const admitted = run('local');
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stdout, 'started');
  const compilation = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=compilation', '--machine=local'], { env, encoding: 'utf8' });
  assert.equal(compilation.status, 1, compilation.stderr);
  assert.match(compilation.stderr, /requires=22020096 KiB/);

  // Explicit local execution shares the same gate, waits without starting
  // its payload, and resumes when the observed memory floor is available.
  writeFakeBin({ root: fixture.root, name: 'vitest', content: '#!/bin/sh\nprintf started\n' });
  await writeFile(memory, '8388607 73400320\n');
  const child = spawn('/bin/sh', [launcher, '--local', '--', 'vitest', 'run'], { env });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    await waitForAdmissionDecision(child, () => stderr);
    assert.match(stderr, /requires=8388608 KiB/);
    assert.equal(stdout, '');
    await writeFile(memory, '8388608 73400320\n');
    assert.equal(await exited, 0, stderr);
    assert.equal(stdout, 'started');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});

test('heavyweight admission backfills fitting work within the blocked head envelope then gives the head capacity priority', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admission-backfill-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root, admissionRoot: fixture.path('heavyweight-admission-v1') });
  const memory = fixture.path('memory');
  const marker = fixture.path('large-started');
  await writeFile(memory, '9437184 47185920\n');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = {
    ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HOME: fixture.root, HAPPIER_HOME_DIR: fixture.root, HAPPIER_STACK_CLI_HOME_DIR: fixture.root,
    FIXTURE_MEMORY: memory, HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
  };
  const runSmall = (check = false) => spawnSync('/bin/sh', [launcher,
    check ? '--heavyweight-admission-check' : '--heavyweight-admission',
    '--class=validation', '--machine=fixture', ...(check ? [] : ['--no-wait', '--', '/bin/sh', '-c', 'printf small']),
  ], { env, encoding: 'utf8' });
  let head, headExited, stderr;
  const startHead = async () => {
    stderr = '';
    head = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=compilation', '--machine=fixture', '--', '/bin/sh', '-c', 'touch "$1"', 'large', marker], { env });
    head.stderr.on('data', chunk => { stderr += chunk; });
    headExited = new Promise(resolveExit => head.once('exit', resolveExit));
    await waitForAdmissionDecision(head, () => stderr);
  };
  t.after(async () => {
    if (head && head.exitCode === null && head.signalCode === null) head.kill('SIGTERM');
    await headExited;
  });
  await startHead();
  await writeFile(memory, '5242880 47185920\n');
  for (let retry = 0; retry < 4; retry++) {
    const unavailable = runSmall();
    assert.equal(unavailable.status, 75, unavailable.stderr);
    assert.equal(unavailable.stdout, '');
  }
  await writeFile(memory, '9437184 47185920\n');
  const firstSmall = runSmall();
  assert.equal(firstSmall.status, 0, firstSmall.stderr);
  assert.equal(firstSmall.stdout, 'small');
  // Read-only probing must never spend a head's backfill envelope.
  for (let probe = 0; probe < 5; probe++) {
    const ready = runSmall(true);
    assert.equal(ready.status, 0, ready.stderr);
  }
  for (let admitted = 1; admitted < 3; admitted++) {
    const small = runSmall();
    assert.equal(small.status, 0, small.stderr);
    assert.equal(small.stdout, 'small');
  }
  const exhausted = runSmall();
  assert.equal(exhausted.status, 75, exhausted.stderr);
  assert.equal(exhausted.stdout, '');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await writeFile(memory, '22020096 47185920\n');
  assert.equal(await headExited, 0, stderr);
  await readFile(marker);
  const afterHead = runSmall();
  assert.equal(afterHead.status, 0, afterHead.stderr);
  // A fresh head has an unused backfill envelope, but approaching its floor
  // already protects enough capacity for it instead of starting another job.
  await writeFile(memory, '18874368 47185920\n');
  await startHead();
  const approaching = runSmall();
  assert.equal(approaching.status, 75, approaching.stderr);
  assert.equal(approaching.stdout, '');
  await writeFile(memory, '22020096 47185920\n');
  assert.equal(await headExited, 0, stderr);
});

test('heavyweight admission reserves unused admitted class memory and releases it on exit and stale reap', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reservations-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  await writeFile(observedPidsPath, '[]');
  const { launcher, admissionRoot: admission } = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const memory = fixture.path('memory');
  await writeFile(memory, '37748736 47185920\n');
  const release = fixture.path('release');
  const marker = fixture.path('started');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_MEMORY: memory,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const args = ['--admission-root=' + admission, '--class=compilation', '--machine=fixture'];
  const owner = spawn('/bin/sh', [launcher, '--heavyweight-admission', ...args, '--', '/bin/sh', '-c', 'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done', 'hold', marker, release], { env });
  let stderr = '';
  owner.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => owner.once('exit', resolveExit));
  let contender;
  let contenderExited;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await readFile(marker); break; } catch (error) {
        if (error.code !== 'ENOENT' || attempt === 250 || owner.exitCode !== null) throw new Error(`owner did not start: ${stderr}`);
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
    }
    const secondMarker = fixture.path('second-started');
    let contenderErr = '';
    contender = spawn('/bin/sh', [launcher, '--heavyweight-admission', ...args, '--', '/bin/sh', '-c', 'touch "$1"', 'second', secondMarker], { env });
    contender.stderr.on('data', chunk => { contenderErr += chunk; });
    contenderExited = new Promise(resolveExit => contender.once('exit', resolveExit));
    for (let attempt = 0; !contenderErr.includes('waiting for heavyweight admission') && contender.exitCode === null; attempt++) {
      if (attempt === 250) throw new Error(`contender did not decide admission: ${contenderErr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    await assert.rejects(readFile(secondMarker), { code: 'ENOENT' }, 'a second 21 GiB class must wait while the first reservation consumes its headroom');
    assert.match(contenderErr, /reserved-memory=22020096/, 'an unobserved owner retains the full class reservation');
    const fullFloorKiB = Number(/ reserved-memory=(\d+)/.exec(contenderErr)?.[1]);
    await writeFile(release, '');
    assert.equal(await exited, 0, stderr);
    assert.equal(await contenderExited, 0, contenderErr);
    await readFile(secondMarker);
    const probe = () => spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', ...args], { env, encoding: 'utf8' });
    // Reentrant owner records are the same authority used by the live probe.
    const token = (await readFile(`/proc/${process.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[19];
    const reserved = join(admission, `owners/${process.pid}-${token}`);
    await mkdir(reserved);
    await writeFile(join(reserved, 'process'), `${process.pid} ${token}\n`);
    await writeFile(join(reserved, 'class'), 'compilation\n');
    await writeFile(observedPidsPath, JSON.stringify([process.pid]));
    const blocked = probe();
    assert.equal(blocked.status, 1, blocked.stderr);
    const unusedKiB = Number(/ reserved-memory=(\d+)/.exec(blocked.stderr)?.[1]);
    assert.ok(unusedKiB > 0 && unusedKiB < fullFloorKiB, 'a recorded live owner reserves only its unused class envelope');
    const declined = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', ...args, '--', '/bin/sh', '-c', 'exit 42'], { env, encoding: 'utf8' });
    assert.equal(declined.status, 75, declined.stderr);
    assert.match(declined.stderr, /heavyweight admission declined before dispatch/);
    // Lower classes still fit; reservations impose memory capacity, not one job.
    const light = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--admission-root=' + admission, '--class=validation', '--machine=fixture'], { env, encoding: 'utf8' });
    assert.equal(light.status, 0, light.stderr);
    const rssKiB = readLinuxWorkerProcesses().get(process.pid).rssKiB;
    // This headroom cannot fit two full envelopes, but can fit the new class
    // after crediting the authenticated live owner's already-resident memory.
    await writeFile(memory, `${fullFloorKiB * 2 - Math.floor(rssKiB / 2)} 47185920\n`);
    const residentCredit = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', ...args,
      '--', '/usr/bin/printf', 'unused-reservation-admitted'], { env, encoding: 'utf8' });
    assert.equal(residentCredit.status, 0, residentCredit.stderr);
    assert.equal(residentCredit.stdout, 'unused-reservation-admitted');
    const { rm } = await import('node:fs/promises');
    await rm(reserved, { recursive: true });
    assert.equal(probe().status, 0);
    const stale = join(admission, 'owners/99999999-stale');
    await mkdir(stale);
    await writeFile(join(stale, 'process'), '99999999 1\n');
    await writeFile(join(stale, 'class'), 'compilation\n');
    assert.equal(probe().status, 0, 'dead owner must release its memory reservation');
  } finally {
    await writeFile(release, '');
    if (owner.exitCode === null) owner.kill('SIGTERM');
    if (contender && contender.exitCode === null) contender.kill('SIGTERM');
    await exited;
    await contenderExited;
  }
});
