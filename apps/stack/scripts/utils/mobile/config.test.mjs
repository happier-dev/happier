import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMobileExpoConfig } from './config.mjs';

test('resolveMobileExpoConfig defaults dev-client scheme to happier-dev', () => {
  const cfg = resolveMobileExpoConfig({ env: {} });
  assert.equal(cfg.scheme, 'happier-dev');
});
