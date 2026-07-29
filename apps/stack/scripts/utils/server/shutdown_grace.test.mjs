import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveServerShutdownGraceMs } from './shutdown_grace.mjs';

test('resolveServerShutdownGraceMs adds bounded exit overhead to the server deadline', () => {
  assert.equal(resolveServerShutdownGraceMs({}), 5_250);
  assert.equal(resolveServerShutdownGraceMs({ HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200ms' }), 1_450);
  assert.equal(resolveServerShutdownGraceMs({ HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'invalid' }), 5_250);
});
