import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from './fileChangeObserver.mjs';

test('uncontended snapshots do not watch; waits arm, recheck and reuse their subscription', async (t) => {
  const handles = [];
  // fs.watch is the OS boundary: preserve the real observer and snapshot logic.
  const watched = t.mock.method(fs, 'watch', (_directory, _options, listener) => {
    const handle = new EventEmitter();
    handle.close = () => {};
    handles.push({ handle, listener });
    return handle;
  });
  syncBuiltinESMExports();
  const observer = createFileChangeObserver(['fixture-directory']);
  let value = 'held';
  const readSnapshot = () => value;
  const changedBeforeCatchUp = (pending) => Promise.race([pending.then(() => true), nextTurn(false)]);
  try {
    for (let n = 0; n < 3; n++) assert.equal(observer.capture(readSnapshot), 'held');
    assert.equal(watched.mock.callCount(), 0, 'unconsumed captures must not reconfigure native watching');

    const snapshot = observer.capture(readSnapshot);
    value = 'released-before-wait';
    assert.equal(await changedBeforeCatchUp(observer.wait({ snapshot, readSnapshot,
      maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal: t.signal })), true, 'recheck observes a release before arming');
    assert.equal(watched.mock.callCount(), 1);

    const pending = observer.wait({ snapshot: value, readSnapshot, maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal: t.signal });
    value = 'released-after-wait';
    handles[0].listener('rename', 'fixture-lock');
    assert.equal(await changedBeforeCatchUp(pending), true, 'notification observes a release after arming');
    assert.equal(watched.mock.callCount(), 1, 'an active observer reuses its filesystem subscription');
  } finally {
    observer.close();
    watched.mock.restore();
    syncBuiltinESMExports();
  }
});
