import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTauriFeatureArgs } from './build-updater-artifacts.mjs';

test('resolveTauriFeatureArgs enables devtools for publicdev builds', () => {
  assert.deepEqual(resolveTauriFeatureArgs({ environment: 'publicdev' }), ['--features', 'devtools']);
});

test('resolveTauriFeatureArgs enables devtools for preview builds', () => {
  assert.deepEqual(resolveTauriFeatureArgs({ environment: 'preview' }), ['--features', 'devtools']);
});

test('resolveTauriFeatureArgs omits devtools for production builds', () => {
  assert.deepEqual(resolveTauriFeatureArgs({ environment: 'production' }), []);
});

test('resolveTauriFeatureArgs fails closed for an unrecognized environment', () => {
  assert.deepEqual(resolveTauriFeatureArgs({ environment: 'staging' }), []);
});

test('resolveTauriFeatureArgs fails closed when the environment is missing', () => {
  assert.deepEqual(resolveTauriFeatureArgs({}), []);
});
