import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';

test('queued equal-or-larger classes do not observe resources before the live FIFO head', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-head-observation-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const token = readProcessInstanceFingerprintSync(process.pid).slice('linux-proc:'.length);
  await mkdir(`${admissionRoot}/waiters`, { recursive: true });
  await writeFile(`${admissionRoot}/waiters/${process.pid}-${token}`, `${process.pid} ${token} 1 validation 0\n`);
  // Node is the resource observer's OS-process boundary, not queue logic.
  const marker = fixture.path('observed');
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
printf observed >> "$FIXTURE_OBSERVED"
printf 'service 0\\n'
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_OBSERVED: marker,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  for (let queued = 0; queued < 40; queued++) {
    const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
      `--class=${queued % 2 ? 'compilation' : 'validation'}`, '--machine=worker', '--', '/usr/bin/true'], { env, encoding: 'utf8' });
    assert.equal(result.status, 75, result.stderr);
  }
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('a contended admission decision waits in the kernel instead of polling the capacity lock', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-kernel-wait-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  await mkdir(admissionRoot, { recursive: true });
  const ready = fixture.path('locked'), polling = fixture.path('polled');
  const holder = spawn('/usr/bin/flock', [`${admissionRoot}/lock`, '/bin/sh', '-c', 'touch "$1"; read -r release', 'hold', ready]);
  const holderExited = new Promise(resolve => holder.once('exit', resolve));
  let child, childExited;
  t.after(async () => {
    holder.stdin.end('release\n');
    if (child?.exitCode === null) child.kill('SIGTERM');
    await Promise.all([holderExited, childExited]);
  });
  for (let attempt = 0; ; attempt++) {
    try { await access(ready); break; } catch (error) {
      if (error.code !== 'ENOENT' || attempt === 250) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  // Sleep is an OS boundary: observing it here proves the former busy-lock
  // retry path, not a product admission-pressure wait after a real decision.
  writeFakeBin({ root: fixture.root, name: 'sleep', content: '#!/bin/sh\ntouch "$FIXTURE_POLLING"\nexec /bin/sleep "$@"\n' });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=worker', '--', '/usr/bin/true'], {
    env: { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_POLLING: polling,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  childExited = new Promise(resolve => child.once('exit', resolve));
  let kernelWait = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const pid of children) {
      try { if ((await readFile(`/proc/${pid}/wchan`, 'utf8')).includes('locks_lock')) kernelWait = true; } catch {}
    }
    if (kernelWait) break;
    try { await access(polling); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(kernelWait, true, 'contended decision should sleep on the existing kernel lock, not retry processes');
  await assert.rejects(access(polling), { code: 'ENOENT' });
  holder.stdin.end('release\n');
  assert.equal(await childExited, 0);
});

test('nested package admission preserves its live parent and ignores incomplete retired owner records', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-nested-package-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  await mkdir(`${admissionRoot}/owners/99999999-1`, { recursive: true });
  await writeFile(`${admissionRoot}/owners/99999999-1/disk`, 'retired field\n');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '9437184 26676708\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const sanitizedChild = fixture.path('sanitized-child.mjs');
  await writeFile(sanitizedChild, `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sanitizeStackTestRunnerEnv } from ${JSON.stringify(new URL('./utils/test/test_env.mjs', import.meta.url).href)};
const child = spawnSync('/bin/sh', [process.argv[2], '--heavyweight-admission', '--class=package-dist', '--machine=worker', '--no-wait', '--', '/usr/bin/true'], { encoding: 'utf8', env: sanitizeStackTestRunnerEnv(process.env) });
assert.equal(child.status, 0, child.stderr);
`);
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=worker', '--no-wait', '--',
    '/bin/sh', '-eu', '-c', `
    owner="$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT/owners/$(printf '%s' "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" | tr : -)"
    before=$(cat "$owner/process")
    "$1" --heavyweight-admission --class=package-dist --machine=worker --no-wait -- /usr/bin/true
    "$3" "$4" "$1"
    [ "$before" = "$(cat "$owner/process")" ]
    printf '%s' "$before" > "$2"
    `, 'nested-package', launcher, fixture.path('parent'), process.execPath, sanitizedChild], {
    encoding: 'utf8', env: { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(fixture.path('parent'), 'utf8'), /^[0-9]+ [0-9]+$/);
  assert.doesNotMatch(result.stderr, /cannot open|insufficient memory|inherited owner/);
});

test('private mirrors, caller roots and machine aliases share the worker host admission', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-admission-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const started = fixture.path('started');
  const release = fixture.path('release');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '9437184 20971520\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const privateOne = fixture.path('private-one');
  const privateTwo = fixture.path('private-two');
  const owner = spawn('/bin/sh', [launcher, '--heavyweight-admission', `--admission-root=${privateOne}`,
    '--class=validation', '--machine=private-alias-one', '--', '/bin/sh', '-c',
    'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done', 'owner', started, release], {
    env: { ...env, HOME: privateOne, HAPPIER_STACK_CLI_HOME_DIR: privateOne, TMPDIR: privateOne },
  });
  let stderr = '';
  owner.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => owner.once('exit', resolve));
  try {
    for (let attempt = 0; ; attempt++) {
      try { await access(started); break; } catch (error) {
        if (error.code !== 'ENOENT' || attempt === 250 || owner.exitCode !== null) throw new Error(`owner failed to start: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const second = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
      `--admission-root=${privateTwo}`, '--class=validation', '--machine=private-alias-two', '--', '/bin/sh', '-c', 'exit 42'], {
      env: { ...env, HOME: privateTwo, HAPPIER_STACK_CLI_HOME_DIR: privateTwo, HAPPIER_HOME_DIR: privateTwo, TMPDIR: privateTwo }, encoding: 'utf8',
    });
    assert.equal(second.status, 75, second.stderr);
    assert.match(second.stderr, /reserved-memory=6291456|heavyweight admission declined before dispatch/);
    await access(admissionRoot);
    await assert.rejects(access(privateOne), { code: 'ENOENT' });
    await assert.rejects(access(privateTwo), { code: 'ENOENT' });
    await writeFile(release, '');
    assert.equal(await exited, 0, stderr);
    const afterExit = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
      `--admission-root=${privateTwo}`, '--class=validation', '--machine=private-alias-two', '--', '/usr/bin/true'], { env, encoding: 'utf8' });
    assert.equal(afterExit.status, 0, afterExit.stderr);
  } finally {
    await writeFile(release, '');
    if (owner.exitCode === null) owner.kill('SIGTERM');
    await exited;
  }
});

test('a live legacy private-root parent migrates its existing envelope instead of reserving a second job', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-legacy-parent-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const legacyRoot = fixture.path('legacy');
  const fingerprint = readProcessInstanceFingerprintSync(process.pid);
  assert.match(fingerprint, /^linux-proc:[0-9]+$/);
  const token = fingerprint.slice('linux-proc:'.length);
  const owner = `${legacyRoot}/owners/${process.pid}-${token}`;
  await mkdir(owner, { recursive: true });
  await writeFile(`${owner}/process`, `${process.pid} ${token}\n`);
  await writeFile(`${owner}/class`, 'validation\n');
  await writeFile(`${owner}/machine`, 'old-private-alias\n');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '9437184 20971520\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', '--class=validation',
    '--machine=new-worker-alias', '--', '/bin/sh', '-c',
    'printf "%s|%s\\n" "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" "$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT"'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: `${process.pid}:${token}`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: legacyRoot, HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: 'old-private-alias' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${process.pid}:${token}|${admissionRoot}\n`);
  await access(`${admissionRoot}/owners/${process.pid}-${token}/class`);
});

test('a different execution account cannot replace an unavailable host authority with private admission', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-account-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  // Ownership is an OS boundary. This fixture models a host state directory
  // owned by another execution account without changing actual OS identities.
  writeFakeBin({ root: fixture.root, name: 'stat', content: `#!/bin/sh
if [ "$1" = -c ] && [ "$2" = %u ]; then printf '${process.getuid() + 1}\\n'; else exec /usr/bin/stat "$@"; fi
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const privateRoot = fixture.path('private');
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
    `--admission-root=${privateRoot}`, '--class=validation', '--machine=other-account', '--', '/usr/bin/true'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /host-global.*unavailable/);
  await assert.rejects(access(privateRoot), { code: 'ENOENT' });
});

test('native non-Linux execution preserves its existing path without resolving Linux host state', async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-non-linux-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  writeFakeBin({ root: fixture.root, name: 'uname', content: '#!/bin/sh\nprintf "Darwin\\n"\n' });
  writeFakeBin({ root: fixture.root, name: 'stat', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--', '/bin/sh', '-c', 'exit 42'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 42, result.stderr);
  await assert.rejects(access(admissionRoot), { code: 'ENOENT' });
});
