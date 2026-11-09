import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const launcher = new URL('../../../bin/hstack-exec', import.meta.url);
const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;

async function reservationReader(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reservation-custody-' });
  const source = await readFile(launcher, 'utf8');
  const start = source.indexOf('\nread_dispatch_reservation() {');
  const end = source.indexOf('\ncount_active_dispatches() {', start);
  assert.ok(start > 0 && end > start);
  const reader = fixture.path('reader.sh');
  // Execute the real owner without fleet discovery or any replacement of its
  // parsing, lifetime-lock or kernel process-identity decisions.
  await writeFile(reader, `. '${identity}'\n${source.slice(start, end)}\ndispatch_reservation_is_active "$1"\n`);
  const quoteStart = source.indexOf('\nquote_remote() {');
  const quoteEnd = source.indexOf('\nexplicit_remote_restart_options=', quoteStart);
  const reapStart = source.indexOf('\ncancel_remote_execution_record() {');
  const reapEnd = source.indexOf('\nreservation_remote_pending=1', reapStart);
  assert.ok(quoteStart > 0 && quoteEnd > quoteStart && reapStart > 0 && reapEnd > reapStart);
  const reaper = fixture.path('reaper.sh');
  await writeFile(reaper, `. '${identity}'\n${source.slice(start, end)}\n${source.slice(quoteStart, quoteEnd)}
cache_dir=$1
remote_home=$1
remote_custody=$2
selected_name=worker
reservation_path=$1/worker.active.next
execution_id=native-next-dispatch
ssh_config=
ssh_target=worker
# SSH is the genuine transport boundary; the cancellation owner and remote
# custody/process identity logic remain real.
ssh() {
  [ "\${CUSTODY_SSH_STATUS:-0}" = 0 ] || return "$CUSTODY_SSH_STATUS"
  for argument in "$@"; do remote_command=$argument; done
  /bin/sh -c "$remote_command"
}
${source.slice(reapStart, reapEnd)}
`);
  return { ...fixture,
    active: record => spawnSync('/bin/sh', [reader, record], { encoding: 'utf8' }),
    reap: (transportStatus = 0) => spawnSync('/bin/sh', [reaper, fixture.root, new URL('./remote_execution_custody.sh', import.meta.url).pathname], {
      encoding: 'utf8', env: { ...process.env, CUSTODY_SSH_STATUS: String(transportStatus) },
    }),
  };
}

async function remoteExecution(t, fixture) {
  const pidFile = fixture.path('remote-exec/native-retained-controller.pid');
  const child = spawn('/bin/bash', [new URL('./remote_execution_custody.sh', import.meta.url).pathname,
    'run', pidFile, 'native-retained-controller', '/bin/sh', '-c', 'printf ready; read release'], {
    env: { ...process.env, HAPPIER_REMOTE_EXEC_LIFELINE: '0', HAPPIER_REMOTE_EXEC_CONTROL_STDIN: '0', TMPDIR: fixture.root },
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  t.after(async () => { if (!child.stdin.writableEnded) child.stdin.end('release\n'); await closed; });
  await once(child.stdout, 'data');
  return { child, closed, pidFile, stderr: () => stderr };
}

async function liveController(t, record, locked) {
  const child = spawn('/bin/sh', ['-c', `${locked ? 'exec 8>>"$1"; flock 8; ' : ''}printf ready; read release`, 'controller', record]);
  const closed = once(child, 'close');
  t.after(async () => { if (!child.stdin.writableEnded) child.stdin.end('release\n'); await closed; });
  await once(child.stdout, 'data');
  const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
  const birth = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  // Retained native reservations have five lines. Preserve the actual kernel
  // incarnation; availability of flock is an OS boundary, not a new format.
  await writeFile(record, `${child.pid}\nvalidation\nnative-retained-controller\n${birth}\n\n`);
  return { child, closed };
}

test('a live legacy controller with an unlocked reservation is not an orphan', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await reservationReader(t);
  const record = fixture.path('worker.active.legacy');
  const controller = await liveController(t, record, false);
  const remote = await remoteExecution(t, fixture);
  const second = fixture.reap();
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotThrow(() => process.kill(controller.child.pid, 0));
  assert.doesNotMatch(second.stderr, /reaping remote execution native-retained-controller/,
    'a second dispatch must not cancel the remote execution of a live controller');
  assert.equal(remote.child.exitCode, null);
  const result = fixture.active(record);
  assert.equal(result.status, 0, 'an unlocked reservation is not proof that its live controller is gone');
  const metadata = (await readFile(record, 'utf8')).split('\n');
  await writeFile(record, metadata.slice(0, 3).join('\n') + '\n');
  assert.equal(fixture.active(record).status, 0, 'a retained record without a birth witness cannot prove a live PID retired');
});

test('a held lifetime lock remains authoritative across PID namespaces', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await reservationReader(t);
  const record = fixture.path('worker.active.locked');
  await liveController(t, record, true);
  await writeFile(record, '2147483647\nvalidation\nnative-retained-controller\n1\n\n');
  assert.equal(fixture.active(record).status, 0);
});

for (const change of ['replacement', 'removal']) {
  test(`reservation inode ${change} cannot authorize cancellation of a live controller`, { skip: process.platform !== 'linux' }, async t => {
    const fixture = await reservationReader(t);
    const record = fixture.path('worker.active.changed');
    const controller = await liveController(t, record, true);
    const remote = await remoteExecution(t, fixture);
    if (change === 'replacement') {
      const metadata = await readFile(record, 'utf8');
      await rename(record, fixture.path('original-locked-inode'));
      await writeFile(record, metadata);
    } else {
      await unlink(record);
    }
    const second = fixture.reap();
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /reaping remote execution native-retained-controller/);
    assert.doesNotThrow(() => process.kill(controller.child.pid, 0));
    assert.equal(remote.child.exitCode, null);
  });
}

test('an unlocked reservation becomes reapable after its real controller exits', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await reservationReader(t);
  const record = fixture.path('worker.active.dead');
  const { child, closed } = await liveController(t, record, false);
  const remote = await remoteExecution(t, fixture);
  child.stdin.end('release\n');
  await closed;
  assert.equal(fixture.active(record).status, 1, 'dead-controller cleanup must remain enabled');
  const failedCancel = fixture.reap(1);
  assert.equal(failedCancel.status, 0, failedCancel.stderr);
  assert.match(failedCancel.stderr, /remote cancellation unconfirmed/);
  await readFile(record);
  assert.equal(remote.child.exitCode, null, 'a failed transport cannot confirm the remote tree stopped');
  const second = fixture.reap();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /reaping remote execution native-retained-controller/);
  const signal = second.stderr.split('\n').filter(line => line.startsWith('[preferred-execution] custody_signal '))
    .map(line => JSON.parse(line.slice('[preferred-execution] custody_signal '.length)));
  assert.ok(signal.some(event => event.reason === 'controller_orphan_cleanup'
    && event.execution_id === 'native-retained-controller' && event.initiating_execution_id === 'native-next-dispatch'));
  const [code, exitSignal] = await remote.closed;
  assert.ok(code !== 0 || exitSignal !== null, remote.stderr());
  assert.equal(await readFile(record, 'utf8').then(() => true, () => false), false,
    'confirmed cancellation must release the dead controller reservation');
});
