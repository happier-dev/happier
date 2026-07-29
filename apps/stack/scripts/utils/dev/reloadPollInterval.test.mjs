import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDevReloadPollIntervalMs } from './reloadPollInterval.mjs';

test('resolveDevReloadPollIntervalMs uses a low-frequency fallback sweep by default', () => {
  assert.equal(resolveDevReloadPollIntervalMs({}), 10_000);
  assert.equal(resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '750' }), 750);
  assert.equal(resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '0' }), 0);
});
