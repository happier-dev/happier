import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkspaceBundlePublicationMode } from './workspaceBundlePublication.mjs';

test('workspace bundle publication defaults to live resolver-safe retention', () => {
  assert.equal(resolveWorkspaceBundlePublicationMode({ argv: [], env: {} }), 'live');
});

test('workspace bundle publication uses exact artifact output for npm prepack', () => {
  assert.equal(
    resolveWorkspaceBundlePublicationMode({ argv: [], env: { npm_lifecycle_event: 'prepack' } }),
    'artifact',
  );
});

test('workspace bundle publication accepts the explicit artifact flag', () => {
  assert.equal(resolveWorkspaceBundlePublicationMode({ argv: ['--artifact'], env: {} }), 'artifact');
});

test('workspace bundle publication rejects unknown explicit modes', () => {
  assert.throws(
    () => resolveWorkspaceBundlePublicationMode({ mode: 'partial', argv: [], env: {} }),
    /Unknown workspace bundle publication mode/,
  );
});
