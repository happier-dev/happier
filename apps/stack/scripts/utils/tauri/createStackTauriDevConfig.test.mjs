import test from 'node:test';
import assert from 'node:assert/strict';

import { createStackTauriDevConfig } from './createStackTauriDevConfig.mjs';

test('createStackTauriDevConfig points Tauri dev at the existing Expo server and disables upstream prestart hooks', () => {
  const config = createStackTauriDevConfig({
    baseConfig: {
      productName: 'Happier',
      identifier: 'dev.happier.app',
      build: {
        devUrl: 'http://localhost:8081',
        beforeDevCommand: 'yarn -s tauri:prepare:dev',
        beforeBuildCommand: 'yarn -s tauri:prepare:build',
      },
      app: {
        windows: [{ title: 'Happier' }],
      },
      bundle: {
        createUpdaterArtifacts: true,
      },
    },
    env: {
      HAPPIER_STACK_TAURI_PRODUCT_NAME: 'Happier (Stack)',
      HAPPIER_STACK_TAURI_IDENTIFIER: 'dev.happier.stack',
    },
    devUrl: 'http://127.0.0.1:4173',
    enableDevtools: true,
  });

  assert.equal(config.build.devUrl, 'http://127.0.0.1:4173');
  assert.equal(config.build.beforeDevCommand, '');
  assert.equal(config.build.beforeBuildCommand, '');
  assert.equal(config.productName, 'Happier (Stack)');
  assert.equal(config.identifier, 'dev.happier.stack');
  assert.equal(config.app.windows[0].title, 'Happier (Stack)');
  assert.equal(config.app.windows[0].devtools, true);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
});
