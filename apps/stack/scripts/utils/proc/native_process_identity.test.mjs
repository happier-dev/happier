import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { isRecordedStackProcessRetired } from './ownership.mjs';

test('native admission retirement agrees with shared recorded-process retirement on the same host evidence', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'native-retirement-parity-' });
  const source = new URL('./native_process_identity.sh', import.meta.url).pathname;
  const fingerprint = readProcessInstanceFingerprintSync(process.pid);
  const token = fingerprint.slice('linux-proc:'.length);
  const native = (pid, birth, path = source, signalBoundary = '') => {
    const result = spawnSync('/bin/sh', ['-c', `. "$1"; ${signalBoundary}
      if heavyweight_process_is_provably_retired "$2" "$3"; then printf retired; else printf retained; fi`,
    'retirement-parity', path, String(pid), birth], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout === 'retired';
  };
  for (const [pid, birth] of [[process.pid, token], [process.pid, String(BigInt(token) + 1n)], [2147483647, '1']]) {
    const shared = isRecordedStackProcessRetired(pid, { processInstanceFingerprint: `linux-proc:${birth}` });
    assert.equal(native(pid, birth), shared, `same-host pid=${pid} birth=${birth}`);
  }
  const unavailable = fixture.path('unavailable.sh');
  await writeFile(unavailable, (await readFile(source, 'utf8')).replaceAll('/proc/$heavyweight_token_pid/stat', fixture.path('missing-stat')));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === `/proc/${process.pid}/stat`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const [code, message] of [['EPERM', 'Operation not permitted'], ['EACCES', 'Permission denied'], ['EIO', 'Input/output error']]) {
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error(message), { code }); });
    const shared = isRecordedStackProcessRetired(process.pid, { processInstanceFingerprint: fingerprint });
    assert.equal(shared, false);
    assert.equal(native(process.pid, token, unavailable, `kill() { printf '%s' '${message}' >&2; return 1; }`), shared, code);
  }
});

test('native process identity recognizes the same live process with spaces and parentheses in its name', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'native-process-identity-' });
  const executable = fixture.path('worker (odd)');
  await copyFile('/bin/sleep', executable);
  const child = spawn(executable, ['60']);
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  const fingerprint = readProcessInstanceFingerprintSync(child.pid);
  assert.match(fingerprint, /^linux-proc:[0-9]+$/);
  const token = fingerprint.slice('linux-proc:'.length);
  const observed = spawnSync('/bin/sh', ['-c', `
    . "$1"
    heavyweight_process_token "$2"
    printf '\\n'
    heavyweight_process_is_current "$2" "$3" && printf 'current\\n'
    heavyweight_process_is_current "$2" "$4" || printf 'mismatch\\n'
  `, 'identity', new URL('./native_process_identity.sh', import.meta.url).pathname,
  String(child.pid), token, String(BigInt(token) + 1n)], { encoding: 'utf8' });
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(observed.stdout, `${token}\ncurrent\nmismatch\n`);
});

test('native liveness rejects unreaped terminal processes without expiring idle or orphaned live work', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'native-process-liveness-' });
  const source = await readFile(new URL('./native_process_identity.sh', import.meta.url), 'utf8');
  const owner = fixture.path('identity.sh');
  const stat = fixture.path('stat');
  // Only the kernel stat boundary is replaced; identity and liveness logic run unchanged.
  await writeFile(owner, source.replaceAll('/proc/$heavyweight_token_pid/stat', stat)
    .replaceAll('/proc/$heavyweight_current_pid/stat', stat));
  const observe = token => spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_process_is_current "$2" "$3"',
    'liveness', owner, String(process.pid), token], { encoding: 'utf8' });
  const setState = (state, parent = 1) => writeFile(stat,
    `${process.pid} (worker (idle)) ${state} ${parent} ${Array(17).fill('0').join(' ')} 12345\n`);
  for (const state of ['S', 'R', 'D', 'T']) {
    await setState(state);
    assert.equal(observe('12345').status, 0, `${state}: a live orphan must retain its resource reservation`);
    assert.equal(observe('12346').status, 1, 'PID reuse is not the recorded owner');
  }
  for (const state of ['Z', 'X', 'x']) {
    await setState(state);
    assert.equal(observe('12345').status, 1, `${state}: a terminal owner cannot keep admission alive`);
    assert.equal(observe('-').status, 1, 'weak identity must not turn a zombie into live custody');
  }
  await setState('S', process.ppid);
  assert.equal(observe('12345').status, 0, 'an attached sleeping owner is live');
});

test('native liveness rejects a real unreaped Linux zombie', { skip: process.platform !== 'linux' }, async t => {
  const python = spawnSync('python3', ['--version']);
  if (python.error || python.status !== 0) { t.skip('python3 is needed to keep a kernel zombie unreaped'); return; }
  const parent = spawn('python3', ['-c', `import os, sys
pid = os.fork()
if pid == 0:
    os._exit(0)
print(pid, flush=True)
sys.stdin.readline()
os.waitpid(pid, 0)
`]);
  const exited = new Promise(resolve => parent.once('exit', resolve));
  t.after(async () => { parent.stdin.end('\n'); await exited; });
  const pid = await new Promise(resolve => parent.stdout.once('data', data => resolve(Number(String(data).trim()))));
  assert.ok(pid > 1);
  let stat;
  for (let attempt = 0; attempt < 250; attempt++) {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z ')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  assert.equal(fields[0], 'Z', 'the real kernel process is terminal but still present');
  const observed = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_process_is_current "$2" "$3"',
    'kernel-liveness', new URL('./native_process_identity.sh', import.meta.url).pathname, String(pid), fields[19]], { encoding: 'utf8' });
  assert.equal(observed.status, 1, 'an unreaped process must not keep a native reservation alive');
});
