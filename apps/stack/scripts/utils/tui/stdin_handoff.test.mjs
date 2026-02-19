import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { detachTuiStdinForChild } from './stdin_handoff.mjs';

test('detachTuiStdinForChild pauses stdin and detaches TUI data handler, then restores it', () => {
  const stdin = new EventEmitter();

  /** @type {string[]} */
  const calls = [];
  // Minimal stream-like surface.
  stdin.pause = () => calls.push('pause');
  stdin.resume = () => calls.push('resume');
  stdin.setRawMode = (v) => calls.push(`raw:${String(Boolean(v))}`);

  const onData = () => {};
  stdin.on('data', onData);
  assert.equal(stdin.listenerCount('data'), 1);

  const { restoreForTui } = detachTuiStdinForChild({ stdin, onData });
  assert.equal(stdin.listenerCount('data'), 0);
  assert.deepEqual(calls, ['pause', 'raw:false']);

  restoreForTui();
  assert.equal(stdin.listenerCount('data'), 1);
  assert.deepEqual(calls, ['pause', 'raw:false', 'raw:true', 'resume']);
});

