import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTuiPaneIdForLabel } from './pane_routing.mjs';

test('resolveTuiPaneIdForLabel routes tauri logs to the tauri pane', () => {
  assert.equal(resolveTuiPaneIdForLabel('tauri'), 'tauri');
});

test('resolveTuiPaneIdForLabel preserves the existing pane routing labels', () => {
  assert.equal(resolveTuiPaneIdForLabel('server'), 'server');
  assert.equal(resolveTuiPaneIdForLabel('ui'), 'expo');
  assert.equal(resolveTuiPaneIdForLabel('mobile'), 'expo');
  assert.equal(resolveTuiPaneIdForLabel('daemon'), 'daemon');
  assert.equal(resolveTuiPaneIdForLabel('stack'), 'stacklog');
  assert.equal(resolveTuiPaneIdForLabel('local'), 'local');
  assert.equal(resolveTuiPaneIdForLabel('unknown'), 'local');
});
