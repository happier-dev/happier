import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStackStopOptions } from './stack_stop_command.mjs';

test('stack stop exposes daemon preservation as a canonical lifecycle option', () => {
  assert.deepEqual(
    resolveStackStopOptions(['--no-docker', '--preserve-daemon']),
    {
      noDocker: true,
      aggressive: false,
      sweepOwned: false,
      preserveDaemon: true,
    },
  );
});
