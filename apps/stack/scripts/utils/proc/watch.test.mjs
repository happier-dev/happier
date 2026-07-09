import assert from 'node:assert/strict';
import test from 'node:test';

import { watchDebounced } from './watch.mjs';

test('watchDebounced polls an explicit signature so missed fs.watch events still trigger onChange', async () => {
  const calls = [];
  let signature = 'initial';
  let poll = null;
  let pollTimer = null;

  const watcher = watchDebounced({
    paths: ['/tmp/hstack-watch-test'],
    debounceMs: 0,
    onChange(event) {
      calls.push(`${event.eventType}:${event.filename ?? ''}`);
    },
    readSignature() {
      return signature;
    },
    pollIntervalMs: 1234,
    watchImpl: () => ({
      close() {
        calls.push('watch:closed');
      },
    }),
    setIntervalImpl(fn, ms) {
      assert.equal(ms, 1234);
      poll = fn;
      pollTimer = { id: 'poll' };
      return pollTimer;
    },
    clearIntervalImpl(timer) {
      assert.equal(timer, pollTimer);
      calls.push('poll:closed');
    },
  });

  assert.ok(watcher);
  assert.equal(typeof poll, 'function');

  await poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);

  signature = 'changed';
  await poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['poll:']);

  watcher.close();
  assert.ok(calls.includes('watch:closed'));
  assert.ok(calls.includes('poll:closed'));
});
