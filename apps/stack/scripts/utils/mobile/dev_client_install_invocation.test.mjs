import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMobileDevClientInstallInvocation } from './dev_client_install_invocation.mjs';

test('buildMobileDevClientInstallInvocation forwards --port to mobile.mjs args', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--port=14362'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(Array.isArray(invocation.nodeArgs), 'expected nodeArgs array');
  assert.ok(invocation.nodeArgs.includes('--port=14362'), 'expected --port to be forwarded to mobile.mjs');
});

test('buildMobileDevClientInstallInvocation accepts space-separated --port 14362', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--port', '14362'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(Array.isArray(invocation.nodeArgs), 'expected nodeArgs array');
  assert.ok(invocation.nodeArgs.includes('--port=14362'), 'expected --port to be forwarded to mobile.mjs');
});

test('buildMobileDevClientInstallInvocation sets EXPO_APP_SCHEME for dev-client isolation', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install'],
    baseEnv: { USER: 'leeroy', EXPO_APP_SLUG: 'custom-slug' },
  });

  assert.equal(invocation.env.EXPO_APP_SCHEME, invocation.identity.scheme);
  assert.equal(invocation.env.EXPO_APP_BUNDLE_ID, 'dev.happier.app.dev.internal.devclient');
  assert.equal(invocation.env.EXPO_ANDROID_PACKAGE, 'dev.happier.app.internaldev.devclient');
  assert.equal(
    invocation.env.EXPO_APP_SLUG,
    '',
    'expected EXPO_APP_SLUG to be explicitly blank so pipeline env files/Keychain bundles cannot override it',
  );
});

test('buildMobileDevClientInstallInvocation selects public dev profile identities', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--profile=publicdev'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.equal(invocation.profile, 'publicdev');
  assert.equal(invocation.identity.iosAppName, 'Happier (dev)');
  assert.equal(invocation.identity.iosBundleId, 'dev.happier.app.publicdev.devclient');
  assert.equal(invocation.identity.androidPackage, 'dev.happier.app.publicdev.devclient');
  assert.equal(invocation.identity.scheme, 'happier-dev');
  assert.equal(invocation.env.EXPO_APP_BUNDLE_ID, 'dev.happier.app.publicdev.devclient');
  assert.equal(invocation.env.EXPO_ANDROID_PACKAGE, 'dev.happier.app.publicdev.devclient');
  assert.ok(invocation.nodeArgs.includes('--app-env=publicdev'), 'expected public dev profile app env');
  assert.ok(
    invocation.nodeArgs.includes('--ios-bundle-id=dev.happier.app.publicdev.devclient'),
    'expected public dev iOS bundle id to be forwarded to mobile.mjs',
  );
});

test('buildMobileDevClientInstallInvocation allows overriding scheme via --scheme', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--scheme=acme-dev'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(invocation.nodeArgs.includes('--scheme=acme-dev'), 'expected overridden scheme to be forwarded to mobile.mjs');
  assert.equal(invocation.env.EXPO_APP_SCHEME, 'acme-dev');
});

test('buildMobileDevClientInstallInvocation allows overriding bundle id via --bundle-id', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--bundle-id=com.example.happier.devclient'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(
    invocation.nodeArgs.includes('--ios-bundle-id=com.example.happier.devclient'),
    'expected overridden bundle id to be forwarded to mobile.mjs',
  );
  assert.equal(invocation.env.EXPO_APP_BUNDLE_ID, 'com.example.happier.devclient');
});

test('buildMobileDevClientInstallInvocation allows overriding Android package via --android-package', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--android-package=com.example.happier.android.devclient'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.equal(invocation.identity.androidPackage, 'com.example.happier.android.devclient');
  assert.equal(invocation.env.EXPO_ANDROID_PACKAGE, 'com.example.happier.android.devclient');
});

test('buildMobileDevClientInstallInvocation allows overriding app name via --app-name', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--app-name=Happier Dev (Acme)'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(
    invocation.nodeArgs.includes('--ios-app-name=Happier Dev (Acme)'),
    'expected overridden app name to be forwarded to mobile.mjs',
  );
  assert.equal(invocation.env.EXPO_APP_NAME, 'Happier Dev (Acme)');
});

test('buildMobileDevClientInstallInvocation omits --port when not provided', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(Array.isArray(invocation.nodeArgs), 'expected nodeArgs array');
  assert.ok(!invocation.nodeArgs.some((a) => String(a).startsWith('--port=')), 'expected no --port arg by default');
});
