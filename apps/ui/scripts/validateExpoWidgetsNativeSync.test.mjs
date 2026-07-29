import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertExpoWidgetsIntrospectionOutput,
  stripAnsiSequences,
} from './validateExpoWidgetsNativeSync.mjs';

test('stripAnsiSequences removes terminal color codes from Expo introspection output', () => {
  const raw = "\u001B[32mname\u001B[39m: 'HappierFocusLiveActivity'";
  assert.equal(stripAnsiSequences(raw), "name: 'HappierFocusLiveActivity'");
});

test('assertExpoWidgetsIntrospectionOutput returns the resolved widget and target summary', () => {
  const output = `
    {
      targetName: 'ExpoWidgetsTarget',
      bundleIdentifier: 'dev.happier.app.dev.internal.ExpoWidgetsTarget',
      enablePushNotifications: true,
      widgets: [
        { name: 'HappierFocusWidget' },
        { name: 'HappierSessionsWidget' },
        { name: 'HappierFocusLiveActivity' }
      ]
    }
  `;

  assert.deepEqual(assertExpoWidgetsIntrospectionOutput(output), {
    targetName: 'ExpoWidgetsTarget',
    bundleIdentifier: 'dev.happier.app.dev.internal.ExpoWidgetsTarget',
    enablePushNotifications: true,
    widgetNames: [
      'HappierFocusWidget',
      'HappierSessionsWidget',
      'HappierFocusLiveActivity',
    ],
  });
});

test('assertExpoWidgetsIntrospectionOutput rejects output with ActivityKit push support disabled', () => {
  const output = `
    {
      targetName: 'ExpoWidgetsTarget',
      bundleIdentifier: 'dev.happier.app.dev.internal.ExpoWidgetsTarget',
      enablePushNotifications: false,
      widgets: [
        { name: 'HappierFocusWidget' },
        { name: 'HappierSessionsWidget' },
        { name: 'HappierFocusLiveActivity' }
      ]
    }
  `;

  assert.throws(
    () => assertExpoWidgetsIntrospectionOutput(output),
    /push notifications/i,
  );
});

test('assertExpoWidgetsIntrospectionOutput rejects output that is missing the widget target', () => {
  const output = `
    {
      widgets: [
        { name: 'HappierFocusWidget' },
        { name: 'HappierSessionsWidget' },
        { name: 'HappierFocusLiveActivity' }
      ]
    }
  `;

  assert.throws(
    () => assertExpoWidgetsIntrospectionOutput(output),
    /ExpoWidgetsTarget/i,
  );
});

test('assertExpoWidgetsIntrospectionOutput rejects output that is missing one required widget kind', () => {
  const output = `
    {
      targetName: 'ExpoWidgetsTarget',
      bundleIdentifier: 'dev.happier.app.dev.internal.ExpoWidgetsTarget',
      enablePushNotifications: true,
      widgets: [
        { name: 'HappierFocusWidget' },
        { name: 'HappierSessionsWidget' }
      ]
    }
  `;

  assert.throws(
    () => assertExpoWidgetsIntrospectionOutput(output),
    /HappierFocusLiveActivity/i,
  );
});

test('apps/ui package.json exposes a dedicated Expo widgets native-sync validation script', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const raw = await readFile(join(packageRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);

  assert.equal(
    pkg?.scripts?.['validate:ios:widgets:native-sync'],
    'cross-env EXPO_UNSTABLE_WEB_MODAL=1 node ./scripts/validateExpoWidgetsNativeSync.mjs',
  );
  assert.equal(
    pkg?.scripts?.['validate:ios:widgets:generated-project'],
    'cross-env EXPO_UNSTABLE_WEB_MODAL=1 node ./scripts/validateExpoWidgetsGeneratedProject.mjs',
  );
});

test('apps/ui prebuild validates Expo widgets native sync before deleting generated native directories', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const raw = await readFile(join(packageRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);

  assert.equal(
    pkg?.scripts?.prebuild,
    'yarn -s validate:ios:widgets:native-sync && rm -rf android ios && cross-env EXPO_UNSTABLE_WEB_MODAL=1 expo prebuild && yarn -s validate:rn:repack:generated-project && yarn -s validate:ios:widgets:generated-project',
  );
});
