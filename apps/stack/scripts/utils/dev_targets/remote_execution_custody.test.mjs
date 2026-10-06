import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const custody = new URL('./remote_execution_custody.sh', import.meta.url).pathname;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
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
