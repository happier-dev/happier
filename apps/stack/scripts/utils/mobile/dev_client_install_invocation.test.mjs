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
  assert.equal(
    invocation.env.HAPPIER_EXPO_DEVCLIENT_ADD_GENERATED_SCHEME,
    '0',
    'expected Expo dev-client to skip exp+slug schemes so multiple local dev clients do not collide',
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

test('buildMobileDevClientInstallInvocation uses a custom bundle id as the launch scheme when --scheme is omitted', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--bundle-id=com.example.happier.devclient'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.equal(invocation.identity.scheme, 'com.example.happier.devclient');
  assert.equal(invocation.env.EXPO_APP_SCHEME, 'com.example.happier.devclient');
  assert.ok(
    invocation.nodeArgs.includes('--scheme=com.example.happier.devclient'),
    'expected the unique bundle id scheme to be forwarded to mobile.mjs',
  );
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

test('buildMobileDevClientInstallInvocation derives unique native identity from a custom app name', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--profile=internaldev', '--app-name=Happier (next dev)'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.equal(invocation.identity.iosAppName, 'Happier (next dev)');
  assert.equal(invocation.identity.iosBundleId, 'dev.happier.app.dev.next-dev.devclient');
  assert.equal(invocation.identity.androidPackage, 'dev.happier.app.internaldev.nextdev.devclient');
  assert.equal(invocation.identity.scheme, 'happier-next-dev');
  assert.equal(invocation.env.EXPO_APP_BUNDLE_ID, 'dev.happier.app.dev.next-dev.devclient');
  assert.equal(invocation.env.EXPO_ANDROID_PACKAGE, 'dev.happier.app.internaldev.nextdev.devclient');
  assert.equal(invocation.env.EXPO_APP_SCHEME, 'happier-next-dev');
  assert.ok(
    invocation.nodeArgs.includes('--ios-bundle-id=dev.happier.app.dev.next-dev.devclient'),
    'expected custom app-name bundle id to be forwarded to mobile.mjs',
  );
  assert.ok(
    invocation.nodeArgs.includes('--scheme=happier-next-dev'),
    'expected custom app-name scheme to be forwarded to mobile.mjs',
  );
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
