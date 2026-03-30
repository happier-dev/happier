import test from 'node:test';
import assert from 'node:assert/strict';

import {
  maybeRunInteractiveStackAuthSetup,
  shouldSuppressInteractiveStackAuthSetup,
} from './interactive_stack_auth.mjs';

test('shouldSuppressInteractiveStackAuthSetup disables startup auth inside TUI-managed child sessions', () => {
  assert.equal(shouldSuppressInteractiveStackAuthSetup({ env: { HAPPIER_STACK_TUI: '1' } }), 'tui_managed');
  assert.equal(shouldSuppressInteractiveStackAuthSetup({ env: {} }), null);
});

test('maybeRunInteractiveStackAuthSetup skips interactive startup auth in TUI-managed child sessions', async () => {
  const result = await maybeRunInteractiveStackAuthSetup({
    env: { HAPPIER_STACK_TUI: '1' },
    stackName: 'repo-dev-a1cc5e0671',
    cliHomeDir: '/tmp/nonexistent-cli-home',
    accountCount: 0,
    isInteractive: true,
    autoSeedEnabled: false,
  });

  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: 'tui_managed',
  });
});
