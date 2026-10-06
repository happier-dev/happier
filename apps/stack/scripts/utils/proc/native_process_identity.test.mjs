import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

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
