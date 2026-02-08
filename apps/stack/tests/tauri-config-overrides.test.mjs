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

test('applyStackTauriOverrides supports identifier-only override without changing titles', () => {
  const base = {
    productName: 'Happier',
    identifier: 'dev.happier.app',
    app: { windows: [{ title: 'Happier' }] },
  };

  const out = applyStackTauriOverrides({
    tauriConfig: structuredClone(base),
    env: {
      HAPPIER_STACK_TAURI_IDENTIFIER: 'com.example.only-id',
      HAPPIER_STACK_TAURI_PRODUCT_NAME: '  ',
    },
  });

  assert.equal(out.identifier, 'com.example.only-id');
  assert.equal(out.productName, 'Happier');
  assert.equal(out.app.windows[0].title, 'Happier');
});

test('applyStackTauriOverrides handles missing windows array and missing productName fallback', () => {
  const base = {
    identifier: 'dev.happier.app',
    app: {},
  };

  const out = applyStackTauriOverrides({
    tauriConfig: structuredClone(base),
    env: {},
  });

  assert.equal(out.identifier, 'com.happier.stack');
  assert.equal(out.productName, 'Happier');
  assert.deepEqual(out.app, {});
});
