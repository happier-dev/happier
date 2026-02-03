import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyStackTauriOverrides } from '../scripts/utils/tauri/stack_overrides.mjs';

test('applyStackTauriOverrides keeps upstream productName by default', () => {
  const base = {
    productName: 'Happier',
    identifier: 'dev.happier.app',
    app: { windows: [{ title: 'Happier' }] },
  };

  const out = applyStackTauriOverrides({ tauriConfig: structuredClone(base), env: {} });

  // Default identifier is stack-scoped to avoid reusing storage.
  assert.equal(out.identifier, 'com.happier.stack');
  // Default product name should follow upstream config (not hardcoded to hstack).
  assert.equal(out.productName, 'Happier');
  assert.equal(out.app.windows[0].title, 'Happier');
});

test('applyStackTauriOverrides respects env overrides', () => {
  const base = {
    productName: 'Happier',
    identifier: 'dev.happier.app',
    app: { windows: [{ title: 'Happier' }] },
  };

  const out = applyStackTauriOverrides({
    tauriConfig: structuredClone(base),
    env: {
      HAPPIER_STACK_TAURI_IDENTIFIER: 'com.example.custom',
      HAPPIER_STACK_TAURI_PRODUCT_NAME: 'CustomName',
    },
  });

  assert.equal(out.identifier, 'com.example.custom');
  assert.equal(out.productName, 'CustomName');
  assert.equal(out.app.windows[0].title, 'CustomName');
});
