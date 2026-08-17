import test from 'node:test';
import assert from 'node:assert/strict';

import * as daemonModule from './daemon.mjs';

test('Stack does not expose external cleanup ownership for CLI daemon state', () => {
  assert.equal('cleanupStaleDaemonState' in daemonModule, false);
});
