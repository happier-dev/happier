import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStackTauriOverrides } from './stack_overrides.mjs';

test('applyStackTauriOverrides derives stack-scoped app identity when no explicit override is provided', () => {
  const config = applyStackTauriOverrides({
    tauriConfig: {
      productName: 'Happier',
      identifier: 'dev.happier.app',
      app: {
        windows: [{ title: 'Happier' }],
      },
      bundle: {
        createUpdaterArtifacts: true,
      },
    },
    env: {
      HAPPIER_STACK_STACK: 'local-prod',
    },
  });

  assert.equal(config.identifier, 'com.happier.stack.local-prod');
  assert.equal(config.productName, 'Happier (local-prod)');
  assert.equal(config.app.windows[0]?.title, 'Happier (local-prod)');
  assert.equal(config.bundle.createUpdaterArtifacts, false);
});
