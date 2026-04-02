import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readRepoFile(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function loadUiFingerprintConfig() {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const abs = path.join(repoRoot, 'apps', 'ui', 'fingerprint.config.js');
  // Ensure this path exists so failures are explicit in tests.
  assert.ok(fs.existsSync(abs), `Expected UI fingerprint config at ${abs}`);
  // eslint-disable-next-line import/no-dynamic-require
  return require(abs);
}

test('UI fingerprint config canonicalizes eas.json by APP_ENV', () => {
  const config = loadUiFingerprintConfig();
  assert.equal(typeof config?.fileHookTransform, 'function', 'Expected fingerprint.config.js to export fileHookTransform');

  const easJson = readRepoFile('apps/ui/eas.json');

  const originalAppEnv = process.env.APP_ENV;
  try {
    process.env.APP_ENV = 'publicdev';
    const out = config.fileHookTransform(
      { type: 'file', filePath: 'eas.json' },
      Buffer.from(easJson, 'utf8'),
      true,
      'utf8',
    );
    assert.equal(typeof out, 'string', 'Expected eas.json transform to return a string at EOF');
    const parsed = JSON.parse(out);
    const keys = Object.keys(parsed?.build ?? {});
    assert.ok(keys.includes('base'), 'Expected canonical eas.json to keep build.base');
    assert.ok(keys.includes('publicdev'), 'Expected canonical eas.json to keep publicdev build profile');
    assert.ok(keys.includes('publicdev-apk'), 'Expected canonical eas.json to keep publicdev-apk build profile');
    assert.ok(!keys.includes('internaldev'), 'Expected canonical eas.json to drop unrelated internaldev build profile');
    assert.ok(!keys.includes('preview'), 'Expected canonical eas.json to drop unrelated preview build profile');
    assert.ok(!keys.includes('production'), 'Expected canonical eas.json to drop unrelated production build profile');
  } finally {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  }
});

test('UI fingerprint config keeps inherited profiles (e.g. canary extends internalpreview) when APP_ENV matches', () => {
  const config = loadUiFingerprintConfig();
  const easJson = readRepoFile('apps/ui/eas.json');

  const originalAppEnv = process.env.APP_ENV;
  try {
    process.env.APP_ENV = 'internalpreview';
    const out = config.fileHookTransform(
      { type: 'file', filePath: 'eas.json' },
      Buffer.from(easJson, 'utf8'),
      true,
      'utf8',
    );
    assert.equal(typeof out, 'string', 'Expected eas.json transform to return a string at EOF');
    const parsed = JSON.parse(out);
    const keys = Object.keys(parsed?.build ?? {});
    assert.ok(keys.includes('internalpreview'), 'Expected canonical eas.json to keep internalpreview build profile');
    assert.ok(keys.includes('canary'), 'Expected canonical eas.json to keep canary build profile (inherits internalpreview APP_ENV)');
    assert.ok(keys.includes('canary-apk'), 'Expected canonical eas.json to keep canary-apk build profile (inherits internalpreview APP_ENV)');
  } finally {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  }
});

test('UI fingerprint config canonicalizes appVariantConfig.cjs by APP_ENV', () => {
  const config = loadUiFingerprintConfig();
  assert.equal(typeof config?.fileHookTransform, 'function', 'Expected fingerprint.config.js to export fileHookTransform');

  const variantSrc = readRepoFile('apps/ui/appVariantConfig.cjs');

  const originalAppEnv = process.env.APP_ENV;
  try {
    process.env.APP_ENV = 'publicdev';
    const out = config.fileHookTransform(
      { type: 'file', filePath: 'appVariantConfig.cjs' },
      Buffer.from(variantSrc, 'utf8'),
      true,
      'utf8',
    );
    assert.equal(typeof out, 'string', 'Expected appVariantConfig.cjs transform to return a string at EOF');
    assert.match(out, /publicdev/i, 'Expected canonical variant representation to mention publicdev');
    assert.ok(!out.toLowerCase().includes('internalpreview'), 'Expected canonical variant representation to avoid unrelated variants');
  } finally {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  }
});

test('UI fingerprint config is a no-op when APP_ENV is missing', () => {
  const config = loadUiFingerprintConfig();
  const easJson = readRepoFile('apps/ui/eas.json');

  const originalAppEnv = process.env.APP_ENV;
  try {
    delete process.env.APP_ENV;
    const out = config.fileHookTransform(
      { type: 'file', filePath: 'eas.json' },
      Buffer.from(easJson, 'utf8'),
      true,
      'utf8',
    );
    // We intentionally allow pass-through in this case so local tooling is not surprised.
    assert.equal(out.toString(), easJson);
  } finally {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  }
});

test('UI fingerprint config strips volatile extra.app keys from expoConfig contents', () => {
  const config = loadUiFingerprintConfig();
  assert.equal(typeof config?.fileHookTransform, 'function', 'Expected fingerprint.config.js to export fileHookTransform');

  const expoConfigA = {
    name: 'Happier (dev)',
    runtimeVersion: { policy: 'fingerprint' },
    extra: {
      app: {
        variant: 'preview',
        identityVariant: 'publicdev',
        postHogKey: 'phc_abc',
        revenueCatAppleKey: 'rc_apple_1',
        revenueCatGoogleKey: 'rc_google_1',
        revenueCatStripeKey: 'rc_stripe_1',
      },
    },
  };
  const expoConfigB = {
    ...expoConfigA,
    extra: {
      ...expoConfigA.extra,
      app: {
        ...expoConfigA.extra.app,
        postHogKey: 'phc_def',
        revenueCatAppleKey: 'rc_apple_2',
        revenueCatGoogleKey: 'rc_google_2',
        revenueCatStripeKey: 'rc_stripe_2',
      },
    },
  };

  const originalAppEnv = process.env.APP_ENV;
  try {
    process.env.APP_ENV = 'publicdev';
    const outA = config.fileHookTransform(
      { type: 'contents', id: 'expoConfig' },
      Buffer.from(JSON.stringify(expoConfigA), 'utf8'),
      true,
      'utf8',
    );
    const outB = config.fileHookTransform(
      { type: 'contents', id: 'expoConfig' },
      Buffer.from(JSON.stringify(expoConfigB), 'utf8'),
      true,
      'utf8',
    );

    assert.equal(typeof outA, 'string', 'Expected expoConfig transform to return a string at EOF');
    assert.equal(typeof outB, 'string', 'Expected expoConfig transform to return a string at EOF');

    assert.equal(outA, outB, 'Expected volatile keys to be removed so output stays stable across env value changes');

    const parsed = JSON.parse(outA);
    assert.equal(parsed?.extra?.app?.variant, 'preview');
    assert.equal(parsed?.extra?.app?.identityVariant, 'publicdev');
    assert.equal('postHogKey' in (parsed?.extra?.app ?? {}), false);
    assert.equal('revenueCatAppleKey' in (parsed?.extra?.app ?? {}), false);
    assert.equal('revenueCatGoogleKey' in (parsed?.extra?.app ?? {}), false);
    assert.equal('revenueCatStripeKey' in (parsed?.extra?.app ?? {}), false);
  } finally {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  }
});

test('UI fingerprint config defines ignorePaths for EAS-managed prebuild output and volatile native artifacts', () => {
  const config = loadUiFingerprintConfig();

  // When EAS runs `expo prebuild`, it generates `android/` and `ios/` directories during the build.
  // The fingerprint runtimeVersion policy must stay stable between the machine that schedules the build
  // and the EAS worker that performs the build.
  assert.ok(Array.isArray(config?.ignorePaths), 'Expected fingerprint.config.js to export ignorePaths[]');

  const ignorePaths = config.ignorePaths.map((p) => String(p));

  // Ignore the generated native directories (both the dir source and its contents).
  assert.ok(ignorePaths.includes('android') || ignorePaths.includes('android/**'), 'Expected ignorePaths to ignore android');
  assert.ok(ignorePaths.includes('ios') || ignorePaths.includes('ios/**'), 'Expected ignorePaths to ignore ios');

  // Ignore libsodium build outputs which can differ across environments (macOS vs Linux).
  assert.ok(
    ignorePaths.some((p) => p.includes('react-native-libsodium') && p.includes('libsodium') && p.includes('build')),
    'Expected ignorePaths to ignore react-native-libsodium libsodium/build outputs',
  );
});
