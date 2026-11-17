import assert from 'node:assert/strict';
import { test } from 'vitest';
import { deleteLimaInstance } from '../machineLima.mjs';

const instance = 'happier-teardown-test';
const store = '/tmp/happier-teardown-test';

test('Delete preserves a native failure for the provisioner to report while retaining the disk', async () => {
  const failure = Object.assign(new Error('native deletion failed'), { code: 'native_command_failed' });
  const executor = {
    capture: async () => ({ exitCode: 0, out: JSON.stringify({ name: instance, dir: `${store}/${instance}`, status: 'Stopped' }) }),
    run: async () => { throw failure; },
  };
  await assert.rejects(deleteLimaInstance({ executor, instance, store }), error => error === failure);
});

test('Delete removes the stopped disk and confirms absence; repeating Delete is harmless', async () => {
  let present = true;
  const executor = {
    capture: async () => ({ exitCode: 0, out: present
      ? JSON.stringify({ name: instance, dir: `${store}/${instance}`, status: 'Stopped' }) : '' }),
    run: async (_command, args) => {
      assert.deepEqual(args, ['delete', '--force', instance]);
      present = false;
      return { exitCode: 0 };
    },
  };
  assert.deepEqual(await deleteLimaInstance({ executor, instance, store }), { kind: 'absent' });
  assert.equal(present, false);
  assert.deepEqual(await deleteLimaInstance({ executor, instance, store }), { kind: 'absent' });
});

test('A failed Delete result never claims the retained disk is absent', async () => {
  const executor = {
    capture: async () => ({ exitCode: 0, out: JSON.stringify({ name: instance, dir: `${store}/${instance}`, status: 'Stopped' }) }),
    run: async () => ({ exitCode: 1, err: 'disk busy' }),
  };
  assert.deepEqual(await deleteLimaInstance({ executor, instance, store }), { kind: 'unknown' });
});
