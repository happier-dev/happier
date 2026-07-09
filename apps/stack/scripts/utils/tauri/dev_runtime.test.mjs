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

test('resolveStackTauriDevUrl does not trust stale Expo runtime metadata without a verified UI endpoint', () => {
  assert.equal(
    resolveStackTauriDevUrl({
      runtimeState: {
        expo: { webPort: 19364 },
      },
      verifiedUiEndpoint: {
        running: false,
        port: null,
      },
    }),
    'http://localhost:8081',
  );
});

test('resolveStackTauriDevUrl uses the verified UI endpoint over stale Expo runtime metadata', () => {
  assert.equal(
    resolveStackTauriDevUrl({
      runtimeState: {
        expo: { webPort: 19364 },
      },
      verifiedUiEndpoint: {
        running: true,
        port: 19000,
      },
    }),
    'http://localhost:19000',
  );
});

test('resolveStackTauriDevUrl prefers the stack server port when a runtime snapshot is active and Expo is absent', () => {
  assert.equal(
    resolveStackTauriDevUrl({
      runtimeState: {
        runtimeSnapshotId: 'snap-1',
        ports: { server: 3009 },
      },
    }),
    'http://localhost:3009',
  );
});

test('resolveStackTauriDevUrl falls back to the default Metro port when no runtime snapshot is active', () => {
  assert.equal(resolveStackTauriDevUrl({ runtimeState: null }), 'http://localhost:8081');
  assert.equal(
    resolveStackTauriDevUrl({
      runtimeState: {
        ports: { server: 3009 },
      },
    }),
    'http://localhost:8081',
  );
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
        windows: [{ title: 'Happier', dragDropEnabled: false }],
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
  assert.equal(config.app.windows[0]?.dragDropEnabled, false);
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

test('buildStackTauriDevConfig derives stack defaults from the stack name when explicit overrides are absent', () => {
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
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
    },
  });

  assert.equal(config.productName, 'Happier (activity-surfaces-qa)');
  assert.equal(config.identifier, 'com.happier.stack.activity-surfaces-qa');
  assert.equal(config.app.windows[0]?.title, 'Happier (activity-surfaces-qa)');
});
