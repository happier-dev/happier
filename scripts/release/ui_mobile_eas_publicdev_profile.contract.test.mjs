import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui/eas.json defines publicdev profiles for the public nightly dev lane', () => {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  const raw = fs.readFileSync(easPath, 'utf8');
  const eas = JSON.parse(raw);

  const build = eas?.build ?? null;
  assert.equal(typeof build, 'object');

  const publicdev = build?.publicdev ?? null;
  assert.equal(typeof publicdev, 'object');
  assert.equal(publicdev.extends, 'base');
  assert.equal(publicdev.environment, 'preview');
  assert.equal(publicdev.distribution, 'store');
  // User-facing OTA channel should be "dev" (internal lane is "publicdev").
  assert.equal(publicdev.channel, 'dev');
  assert.equal(publicdev?.env?.APP_ENV, 'publicdev');
  assert.equal(publicdev?.env?.EXPO_UPDATES_CHANNEL, 'dev');
  assert.equal(publicdev?.env?.EXPO_APP_NAME, 'Happier (dev)');
  assert.equal(publicdev?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.publicdev');
  assert.equal(publicdev?.env?.EXPO_APP_SCHEME, undefined);

  const publicdevApk = build?.['publicdev-apk'] ?? null;
  assert.equal(typeof publicdevApk, 'object');
  assert.equal(publicdevApk.extends, 'base');
  assert.equal(publicdevApk.environment, 'preview');
  assert.equal(publicdevApk.distribution, 'internal');
  assert.equal(publicdevApk.channel, 'dev');
  assert.equal(publicdevApk?.android?.buildType, 'apk');
  assert.equal(publicdevApk?.env?.APP_ENV, 'publicdev');
  assert.equal(publicdevApk?.env?.EXPO_UPDATES_CHANNEL, 'dev');
  assert.equal(publicdevApk?.env?.EXPO_APP_NAME, 'Happier (dev)');
  assert.equal(publicdevApk?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.publicdev');
  assert.equal(publicdevApk?.env?.EXPO_APP_SCHEME, undefined);

  const publicdevDevClient = build?.['publicdev-dev-client'] ?? null;
  assert.ok(publicdevDevClient, 'expected publicdev-dev-client build profile');
  assert.equal(publicdevDevClient.extends, 'base');
  assert.equal(publicdevDevClient.environment, 'preview');
  assert.equal(publicdevDevClient.developmentClient, true);
  assert.equal(publicdevDevClient.distribution, 'internal');
  assert.equal(publicdevDevClient.channel, 'dev');
  assert.equal(publicdevDevClient?.android?.buildType, 'apk');
  assert.match(publicdevDevClient?.android?.gradleCommand ?? '', /assembleDebug/);
  assert.equal(publicdevDevClient?.env?.APP_ENV, 'publicdev');
  assert.equal(publicdevDevClient?.env?.EXPO_UPDATES_CHANNEL, 'dev');
  assert.equal(publicdevDevClient?.env?.EXPO_APP_NAME, 'Happier (dev)');
  assert.equal(publicdevDevClient?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.publicdev.devclient');
  assert.equal(publicdevDevClient?.env?.EXPO_ANDROID_PACKAGE, 'dev.happier.app.publicdev.devclient');
  assert.equal(publicdevDevClient?.env?.EXPO_APP_SCHEME, 'happier-dev-devclient');
  assert.equal(publicdevDevClient?.env?.HAPPIER_EXPO_USE_NATIVE_DEBUG, undefined);
  assert.equal(publicdevDevClient?.env?.EX_UPDATES_NATIVE_DEBUG, undefined);

  const submit = eas?.submit ?? null;
  assert.equal(typeof submit, 'object');
  const publicdevSubmit = submit?.publicdev ?? null;
  assert.equal(typeof publicdevSubmit, 'object');
  assert.equal(typeof publicdevSubmit?.ios?.ascAppId, 'string');
  assert.ok(String(publicdevSubmit?.ios?.ascAppId ?? '').trim().length > 0);
  assert.equal(publicdevSubmit?.android?.track, 'internal');
});

test('publicdev dev-client local iOS builds cleanly regenerate native code under the EAS profile environment', async () => {
  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const packageJson = JSON.parse(fs.readFileSync(path.join(uiDir, 'package.json'), 'utf8'));
  const runnerPath = path.join(uiDir, 'scripts', 'runPublicdevDevClientIos.mjs');

  assert.equal(
    packageJson?.scripts?.['ios:publicdev-dev-client'],
    'yarn -s ensure:workspace:built && node ./scripts/runPublicdevDevClientIos.mjs',
  );
  assert.ok(fs.existsSync(runnerPath), 'expected the publicdev dev-client iOS runner to exist');

  const { createPublicdevDevClientIosPlan } = await import(pathToFileURL(runnerPath).href);
  const plan = createPublicdevDevClientIosPlan({
    easJsonPath: path.join(uiDir, 'eas.json'),
    forwardedArgs: ['--device', 'test-device'],
  });

  assert.deepEqual(plan.commands, [
    ['prebuild', '--clean', '--platform', 'ios'],
    ['run:ios', '--device', 'test-device'],
  ]);
  assert.equal(plan.env.APP_ENV, 'publicdev');
  assert.equal(plan.env.EXPO_APP_BUNDLE_ID, 'dev.happier.app.publicdev.devclient');
  assert.equal(plan.env.EXPO_APP_SCHEME, 'happier-dev-devclient');
  assert.equal(plan.env.HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE, 'most-recent');
  assert.equal(plan.env.HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH, 'true');
  assert.equal(plan.env.HAPPIER_EXPO_USE_NATIVE_DEBUG, undefined);
  assert.equal(plan.env.EX_UPDATES_NATIVE_DEBUG, undefined);
  assert.equal(plan.env.HAPPIER_UI_METRO_DISABLE_WATCHMAN, '1');
  assert.equal(plan.env.SENTRY_DISABLE_AUTO_UPLOAD, 'true');
});

test('EAS uploads exclude generated native projects and dependency trees', () => {
  const easIgnore = fs
    .readFileSync(path.join(repoRoot, 'apps', 'ui', '.easignore'), 'utf8')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  assert.ok(easIgnore.includes('/ios/'), 'expected EAS to exclude the generated iOS project');
  assert.ok(easIgnore.includes('/android/'), 'expected EAS to exclude the generated Android project');
  assert.ok(easIgnore.includes('node_modules/'), 'expected EAS to exclude installed dependencies');
});
