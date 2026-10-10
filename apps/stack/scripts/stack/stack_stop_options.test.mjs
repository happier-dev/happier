import assert from 'node:assert/strict';
import test from 'node:test';
import * as command from './stack_stop_command.mjs';

test('public stop admits daemon preservation independently of aggressive cleanup', () => {
  assert.equal(typeof command.resolveStackStopOptions, 'function');
  assert.deepEqual(command.resolveStackStopOptions(['--preserve-daemon', '--no-docker']), {
    noDocker: true, aggressive: false, sweepOwned: false, preserveDaemon: true,
  });
  assert.equal(command.resolveStackStopOptions([]).preserveDaemon, false);
});
