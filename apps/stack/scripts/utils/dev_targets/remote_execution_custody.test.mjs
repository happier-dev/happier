import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';

const custody = new URL('./remote_execution_custody.sh', import.meta.url).pathname;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tempHelper = new URL('../../../../../scripts/testing/process/temporaryDirectories.mjs', import.meta.url).href;

test('dispatch reclaims marked dead temp owners while retaining live groups, reused PIDs and unmarked neighbors', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-custody-' });
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(process.pid)], { encoding: 'utf8' }).stdout;
  const liveGroup = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  t.after(() => liveGroup.kill('SIGTERM'));
  const marker = (pid, start, group) => `happier-test-temp-v1\n${bootId}\n${pid}\n${start}\n${group}\n`;
  const roots = {};
  for (const [name, owner] of Object.entries({
    'happier-stack-unit-dead': marker(2147483647, token, 2147483647),
    'happier-dev-test-reused': marker(process.pid, `${token}0`, 2147483647),
    'happier-external-hooks-config-live': marker(process.pid, token, 2147483647),
    'docs-check-child': marker(2147483647, token, liveGroup.pid),
    'docs-check-unmarked': null,
    'unrelated-scratch': marker(2147483647, '1', 2147483647),
  })) {
    const directory = join(root, name);
    await mkdir(directory);
    if (owner) await writeFile(join(directory, '.happier-test-temp-owner'), owner);
    roots[name] = directory;
  }
  const result = spawnSync('/bin/bash', [custody, 'run', join(root, 'remote-exec/next.pid'), 'next', '/usr/bin/true'], { env: { ...process.env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(roots['happier-stack-unit-dead']), { code: 'ENOENT' });
  await assert.rejects(access(roots['happier-dev-test-reused']), { code: 'ENOENT' });
  for (const name of ['happier-external-hooks-config-live', 'docs-check-child', 'docs-check-unmarked', 'unrelated-scratch']) await access(roots[name]);
  assert.ok(running(liveGroup.pid), 'temp reclamation signaled a live child group');
});

test('SIGKILL temp creator retains its root until its surviving child group exits', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-sigkill-' });
  const creator = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createTestTempDirectory } from ${JSON.stringify(tempHelper)};
    import { spawn } from 'node:child_process';
    const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(root)});
    const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    console.log(JSON.stringify({ root: fixture.root, child: child.pid }));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', childPid, directory;
  creator.stdout.on('data', chunk => { output += chunk; });
  t.after(() => {
    creator.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
  });
  await waitFor(() => output.includes('\n'), 'temp creator did not publish its root');
  ({ root: directory, child: childPid } = JSON.parse(output.trim()));
  const closed = once(creator, 'close');
  creator.kill('SIGKILL');
  await closed;
  const dispatch = () => spawnSync('/bin/bash', [custody, 'run', join(root, 'remote-exec/next.pid'), 'next', '/usr/bin/true'], { env: { ...process.env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(dispatch().status, 0);
  await access(directory);
  assert.ok(running(childPid), 'the reaper killed a surviving temp owner');
  process.kill(childPid, 'SIGTERM');
  await waitFor(() => !running(childPid), 'fixture child did not stop');
  assert.equal(dispatch().status, 0);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('remote cancellation removes roots created by its payload after the group stops', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-cancel-' });
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/cancel.pid'), 'cancel', process.execPath, '--input-type=module', '-e', `
    import { createTestTempDirectory } from ${JSON.stringify(tempHelper)};
    const fixture = createTestTempDirectory('happier-dev-test-bin-');
    console.log(fixture.root);
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  t.after(() => child.kill('SIGTERM'));
  const closed = once(child, 'close');
  await waitFor(() => output.includes('\n'), 'payload did not publish its temp root');
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [130, null], error);
  await assert.rejects(access(output.trim()), { code: 'ENOENT' });
});

test('detached descendants retain inherited temporary roots after their creator and its group exit', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-detached-' });
  const creator = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createTestTempDirectory } from ${JSON.stringify(tempHelper)};
    import { spawn } from 'node:child_process';
    const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(root)});
    const child = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    console.log(JSON.stringify({ root: fixture.root, child: child.pid }));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', childPid, directory;
  creator.stdout.on('data', chunk => { output += chunk; });
  t.after(() => {
    creator.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
  });
  await waitFor(() => output.includes('\n'), 'detached creator did not publish its root');
  ({ root: directory, child: childPid } = JSON.parse(output.trim()));
  const closed = once(creator, 'close');
  creator.kill('SIGKILL');
  await closed;
  const dispatch = () => spawnSync('/bin/bash', [custody, 'run', join(root, 'remote-exec/detached.pid'), 'detached', '/usr/bin/true'], { env: { ...process.env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(dispatch().status, 0);
  await access(directory);
  assert.ok(running(childPid), 'the reaper signaled an escaped temp owner');
  process.kill(childPid, 'SIGTERM');
  await waitFor(() => !running(childPid), 'detached fixture child did not stop');
  assert.equal(dispatch().status, 0);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
function running(pid) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('new dispatch reaps identified legacy native orphans and preserves live and reused PID neighbors', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-custody-' });
  const records = join(root, 'remote-exec');
  await mkdir(records);
  const orphanId = 'native-orphan-1791280000';
  const orphanFile = join(records, `${orphanId}.pid`);
  const childFile = join(root, 'stubborn.pid');
  const body = `printf '%s\\n' "$$" > ${quote(orphanFile)}; bash -c ${quote(`trap '' TERM; printf '%s\\n' "$$" > ${quote(childFile)}; while :; do sleep 1; done`)} & wait`;
  const parent = spawnSync(process.execPath, ['-e', `require('node:child_process').spawn('/bin/bash', ['-c', ${JSON.stringify(body)}, ${JSON.stringify(orphanId)}], { detached: true, stdio: 'ignore' }).unref();`]);
  assert.equal(parent.status, 0);
  let orphanPid, childPid;
  t.after(() => {
    for (const pid of [orphanPid, childPid]) { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  });
  await waitFor(async () => {
    orphanPid = Number(await readFile(orphanFile, 'utf8').catch(() => '0'));
    childPid = Number(await readFile(childFile, 'utf8').catch(() => '0'));
    return orphanPid > 0 && childPid > 0;
  }, 'legacy native execution did not start');
  const liveId = 'native-live-1791280000';
  const live = spawn('/bin/bash', ['-c', 'while :; do sleep 1; done', liveId], { stdio: 'ignore' });
  t.after(() => live.kill('SIGTERM'));
  const liveFile = join(records, `${liveId}.pid`);
  await writeFile(liveFile, `${live.pid}\n`);
  const reusedFile = join(records, 'native-reused-1791280000.pid');
  await writeFile(reusedFile, `${live.pid}\n`);
  const unrelatedFile = join(root, 'unrelated.pid');
  const unrelatedParent = spawnSync(process.execPath, ['-e', `const child = require('node:child_process').spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(unrelatedFile)}, String(child.pid)); child.unref();`]);
  assert.equal(unrelatedParent.status, 0);
  const unrelatedPid = Number(await readFile(unrelatedFile, 'utf8'));
  t.after(() => { try { process.kill(unrelatedPid, 'SIGTERM'); } catch {} });
  const mismatchedFile = join(records, 'native-mismatched-1791280000.pid');
  await writeFile(mismatchedFile, `${unrelatedPid}\n`);
  const result = spawnSync('/bin/bash', [custody, 'run', join(records, 'native-next-1791280000.pid'), 'native-next-1791280000', '/usr/bin/true'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await waitFor(() => !running(childPid) && !running(orphanPid), 'legacy orphan survived reaping');
  await assert.rejects(readFile(orphanFile), { code: 'ENOENT' });
  assert.ok(running(live.pid), 'live neighbor was terminated');
  assert.equal(await readFile(liveFile, 'utf8'), `${live.pid}\n`);
  assert.equal(await readFile(reusedFile, 'utf8'), `${live.pid}\n`);
  assert.ok(running(unrelatedPid), 'an orphan with mismatched execution identity was terminated');
  await assert.rejects(readFile(mismatchedFile), { code: 'ENOENT' });
});

test('remote custody preserves payload input when no lifetime pipe is requested', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-input-' });
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/input-custody.pid'), 'input-custody', '/bin/cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const closed = once(child, 'close');
  child.stdin.end('input survives custody\n');
  assert.deepEqual(await closed, [0, null]);
  assert.equal(output, 'input survives custody\n');
  await assert.rejects(readFile(join(root, 'remote-exec/input-custody.pid')), { code: 'ENOENT' });
});

test('control input reaches the admitted payload and EOF cancels its process tree', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-control-' });
  const pidFile = join(root, 'remote-exec/control-custody.pid');
  const child = spawn('/bin/bash', [custody, 'run', pidFile, 'control-custody', process.execPath, '-e', `
    console.log('READY');
    process.stdin.once('data', chunk => console.log('BODY:' + chunk.toString().trim()));
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, HAPPIER_REMOTE_EXEC_LIFELINE: '1', HAPPIER_REMOTE_EXEC_CONTROL_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const closed = once(child, 'close');
  await waitFor(() => output.includes('READY\n'), 'controller did not become ready');
  assert.doesNotMatch(output, /BODY:/);
  child.stdin.write('{"requestPath":"/tmp/request"}\n');
  await waitFor(() => output.includes('BODY:{"requestPath":"/tmp/request"}'), 'control ACK never reached payload');
  child.stdin.end();
  assert.deepEqual(await closed, [130, null]);
  await assert.rejects(readFile(pidFile), { code: 'ENOENT' });
});

test('control input survives the native admitted process tree', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-admitted-control-' });
  const native = await installNativeAdmissionFixture({ root });
  writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "28000000 30000000\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/native-input.pid'), 'native-input', '/bin/sh', native.launcher, '--heavyweight-admission', '--class=runtime-build', '--machine=worker', '--', process.execPath, '-e', `
    console.log('READY');
    process.stdin.once('data', chunk => { console.log('BODY:' + chunk.toString().trim()); process.exit(0); });
    process.stdin.once('end', () => process.exit(91));
  `], { env: { ...process.env, PATH: join(root,'bin') + ':' + process.env.PATH, HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '', HAPPIER_REMOTE_EXEC_LIFELINE: '1', HAPPIER_REMOTE_EXEC_CONTROL_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const closed = once(child, 'close');
  await waitFor(() => output.includes('READY\n'), 'native controller did not become ready: ' + error);
  child.stdin.write('{"requestPath":"/tmp/request"}\n');
  assert.deepEqual(await closed, [0, null], error);
  assert.match(output, /BODY:/);
});

test('remote custody cleans up stubborn descendants after the command leader exits and preserves its result', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-leader-exit-' });
  const marker = join(root, 'child.pid');
  const body = `bash -c ${quote(`trap '' TERM; printf '%s\\n' "$$" > ${quote(marker)}; while :; do sleep 1; done`)} & while [ ! -f ${quote(marker)} ]; do sleep 0.01; done; exit 7`;
  let childPid;
  t.after(() => { if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} } });
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/leader-exit.pid'), 'leader-exit', '/bin/bash', '-c', body], { stdio: 'ignore' });
  const closed = once(child, 'close');
  await waitFor(async () => {
    childPid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    return childPid > 0;
  }, 'descendant did not start');
  assert.deepEqual(await closed, [7, null]);
  await waitFor(() => !running(childPid), 'descendant survived normal command leader exit');
});

test('TTY custody cancellation terminates a foreground job that defers wrapper traps', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-tty-' });
  const marker = join(root, 'foreground.pid');
  const pidFile = join(root, 'remote-exec/tty-custody.pid');
  const body = `trap '' TERM; printf '%s\\n' "$$" > ${quote(marker)}; while :; do sleep 1; done`;
  const command = ['/bin/bash', custody, 'run', pidFile, 'tty-custody', '/bin/bash', '-c', body].map(quote).join(' ');
  const terminal = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let childPid;
  t.after(() => {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    if (terminal.exitCode == null && terminal.signalCode == null) terminal.kill('SIGKILL');
  });
  await waitFor(async () => {
    childPid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    return childPid > 0;
  }, 'foreground TTY job did not start');
  const cancel = spawn('/bin/bash', [custody, 'cancel', pidFile, 'tty-custody'], { stdio: 'ignore' });
  const closed = once(cancel, 'close');
  assert.deepEqual(await closed, [0, null]);
  await waitFor(() => !running(childPid), 'foreground TTY job survived cancellation');
  await waitFor(async () => !(await readFile(pidFile, 'utf8').catch(() => '')), 'TTY execution identity survived cancellation');
});

test('delayed group cancellation reports unavailable identity without signaling an unverified group', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-group-identity-' });
  const leader = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  t.after(() => leader.kill('SIGTERM'));
  const pidFile = join(root, 'identity.pid');
  const signals = join(root, 'signals');
  const tokenReads = join(root, 'token-reads');
  await writeFile(pidFile, `${process.pid}\n${leader.pid}\n`);
  // ps, kernel-token reads and signals are the OS boundary. Simulate reuse
  // during TERM grace without creating or signaling any unrelated real group.
  for (const identityState of ['reused', 'unavailable']) {
    const bootstrap = `
    ps() {
      case "$*" in
        '-p ${process.pid} -o command=') printf '%s\\n' identity-execution ;;
        '-p ${leader.pid} -o ppid=') printf '%s\\n' ${process.pid} ;;
        '-p ${leader.pid} -o pgid=') printf '%s\\n' ${leader.pid} ;;
        '-eo pid=,pgid=') printf '%s %s\\n' ${leader.pid} ${leader.pid} ;;
      esac
    }
    awk() {
      if [ "$1" = -v ]; then printf '%s\\n' ${leader.pid}; return; fi
      case "$2" in
        /proc/${leader.pid}/stat)
          ${identityState === 'unavailable' ? 'printf unavailable' : `if [ -f ${quote(tokenReads)} ]; then printf 202; else : > ${quote(tokenReads)}; printf 101; fi`} ;;
        *) printf 303 ;;
      esac
    }
    kill() { printf '%s\\n' "$*" >> ${quote(signals)}; }
    export -f ps awk kill
    exec /bin/bash ${quote(custody)} cancel ${quote(pidFile)} identity-execution
    `;
    const result = spawnSync('/bin/bash', ['-c', bootstrap], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const recorded = await readFile(signals, 'utf8');
    assert.ok(recorded.includes(`-TERM -- -${leader.pid}`), recorded);
    assert.ok(!recorded.includes(`-KILL -- -${leader.pid}`), 'an unverified group was signaled after the grace period');
    assert.ok(result.stderr.trim().length > 0, `${identityState} identity left incomplete cancellation silent`);
    assert.ok(result.stderr.includes(String(leader.pid)), 'diagnostic did not identify the unverified group');
  }
});
