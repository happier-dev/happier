import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStackTauriDevConfig, resolveStackTauriDevUrl } from './dev_runtime.mjs';

test('resolveStackTauriDevUrl prefers the stack expo web port', () => {
  assert.equal(
    resolveStackTauriDevUrl({
      runtimeState: {
        expo: { webPort: 19364 },
      },
    }),
    'http://localhost:19364',
  );
});

test('resolveStackTauriDevUrl falls back to the default Metro port', () => {
  assert.equal(resolveStackTauriDevUrl({ runtimeState: null }), 'http://localhost:8081');
});

test('buildStackTauriDevConfig disables beforeDevCommand and points Tauri at the existing dev server', () => {
  const config = buildStackTauriDevConfig({
    baseConfig: {
      productName: 'Happier',
      identifier: 'dev.happier.app',
      build: {
        devUrl: 'http://localhost:8081',
        beforeDevCommand: 'yarn -s tauri:prepare:dev',
      },
      bundle: {
        externalBin: ['binaries/hsetup'],
      },
      app: {
        windows: [{ title: 'Happier' }],
      },
    },
    overlayConfig: {
      productName: 'Happier (dev)',
      identifier: 'dev.happier.app.publicdev',
      app: {
        windows: [{ title: 'Happier (dev)' }],
      },
    },
    devUrl: 'http://localhost:19364',
    env: {},
  });

  assert.equal(config.productName, 'Happier (dev)');
  assert.equal(config.identifier, 'dev.happier.app.publicdev');
  assert.equal(config.build.devUrl, 'http://localhost:19364');
  assert.equal(config.build.beforeDevCommand, '');
  assert.equal(config.build.beforeBuildCommand, '');
  assert.deepEqual(config.bundle.externalBin, ['binaries/hsetup']);
  assert.equal(config.app.windows[0]?.title, 'Happier (dev)');
});

test('buildStackTauriDevConfig applies explicit stack overrides after merging configs', () => {
  const config = buildStackTauriDevConfig({
    baseConfig: {
      productName: 'Happier',
      identifier: 'dev.happier.app',
      build: {},
      app: { windows: [{ title: 'Happier' }] },
    },
    overlayConfig: {
      productName: 'Happier (dev)',
      identifier: 'dev.happier.app.publicdev',
    },
    devUrl: 'http://localhost:18081',
    env: {
      HAPPIER_STACK_TAURI_PRODUCT_NAME: 'Happier (stack exp1)',
      HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.exp1',
    },
  });

  assert.equal(config.productName, 'Happier (stack exp1)');
  assert.equal(config.identifier, 'com.happier.stack.exp1');
  assert.equal(config.app.windows[0]?.title, 'Happier (stack exp1)');
});
