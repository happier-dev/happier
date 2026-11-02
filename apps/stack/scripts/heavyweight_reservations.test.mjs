import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { resolveHeavyweightMemoryFloorKiB } from './utils/dev_targets/remote_commands.mjs';

async function waitForAdmissionDecision(native, child, readStderr) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if ((await native.brokerStatus()).waitingCount === 1) return;
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`waiter exited before deciding: ${readStderr()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.fail(`waiter did not decide admission: ${readStderr()}`);
}

test('local heavyweight admission protects the browser memory floor without raising worker envelopes', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-local-memory-floor-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root, prepareDependencies: true });
  const { launcher } = native;
  const memory = fixture.path('memory');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, CI: '',
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
  assert.ok((await native.brokerStatus()).unreservedMemoryKiB < 8388608);
  assert.equal(run('worker').status, 0, 'workers retain the measured class envelope');
  assert.equal(run('local', false, { HAPPIER_DEV_TARGET_EXECUTION: '1' }).status, 0, 'already placed workers retain worker admission');
  await writeFile(memory, '8388608 73400320\n');
  const admitted = run('local');
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stdout, 'started');
  const compilation = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=compilation', '--machine=local'], { env, encoding: 'utf8' });
  assert.equal(compilation.status, 1, compilation.stderr);
  assert.ok((await native.brokerStatus()).unreservedMemoryKiB < resolveHeavyweightMemoryFloorKiB('compilation'));

  // Explicit local execution shares the same gate, waits without starting
  // its payload, and resumes when the observed memory floor is available.
  writeFakeBin({ root: fixture.root, name: 'vitest', content: '#!/bin/sh\nprintf started\n' });
  // Preparation consumes the canonical ready, dependency-free worker tree.
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
exec '${process.execPath}' "$@"
` });
  await writeFile(memory, '8388607 73400320\n');
  const pressure = await holdNativeAdmissionFixtureMemory(t, { ...native, env }, { totalKiB: 73400320, availableKiB: 8388607 });
  const child = spawn('/bin/sh', [launcher, '--local', '--', 'vitest', 'run'], {
    env, cwd: join(fixture.root, 'native-owner'),
  });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    await waitForAdmissionDecision(native, child, () => stderr);
    assert.equal(stdout, '');
    await pressure.release(() => writeFile(memory, '8388608 73400320\n'), { availableKiB: 8388608 });
    assert.equal(await exited, 0, stderr);
    assert.equal(stdout, 'started');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
