import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

import './runVitestShards.test.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function readPodVersion(podfileLockContents, podName) {
  const escapedPodName = podName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = podfileLockContents.match(new RegExp(`^  - ${escapedPodName} \\(([^)]+)\\):?`, 'm'));
  return match?.[1] ?? null;
}

test('apps/ui direct @react-navigation/native range satisfies navigator peer requirements', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const directNativeRange = packageJson?.dependencies?.['@react-navigation/native'];

  assert.equal(typeof directNativeRange, 'string');

  const navigatorPackages = [
    '@react-navigation/bottom-tabs',
    '@react-navigation/native-stack',
    '@react-navigation/drawer',
  ];

  for (const packageName of navigatorPackages) {
    const navigatorPackageJson = await readJson(
      join(packageRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
    );
    const requiredNativeRange = navigatorPackageJson?.peerDependencies?.['@react-navigation/native'];

    assert.equal(
      typeof requiredNativeRange,
      'string',
      `${packageName} should declare a @react-navigation/native peer range`,
    );
    assert.equal(
      semver.subset(directNativeRange, requiredNativeRange),
      true,
      `apps/ui declares @react-navigation/native ${directNativeRange}, but ${packageName} requires ${requiredNativeRange}`,
    );
  }
});

test('apps/ui fast test lane includes the navigation package contract check', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const testScript = packageJson?.scripts?.test;
  const unitTestScript = packageJson?.scripts?.['test:unit'];
  const patchScript = packageJson?.scripts?.['postinstall:patches'];

  assert.equal(typeof testScript, 'string');
  assert.match(testScript, /\btest:unit\b/);
  assert.match(testScript, /navigationPackageContract\.test\.mjs/);
  assert.equal(typeof patchScript, 'string');
  assert.match(patchScript, /HAPPIER_UI_VENDOR_WEB_ASSETS=0/);
  assert.match(patchScript, /tools\/postinstall\.mjs/);
  assert.equal(typeof unitTestScript, 'string');
  assert.match(unitTestScript, /\bpostinstall:patches\b/);
  assert.match(unitTestScript, /runVitestShards\.mjs/);
});

test('apps/ui patched expo-router web modal layout enables the experimental modal stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const webModalLayoutPath = join(
    packageRoot,
    'node_modules',
    'expo-router',
    'build',
    'layouts',
    '_web-modal.js',
  );
  const webModalLayoutContents = await readFile(webModalLayoutPath, 'utf-8');

  assert.match(
    webModalLayoutContents,
    /ExperimentalModalStack/,
    'expo-router _web-modal.js should load ExperimentalModalStack when EXPO_UNSTABLE_WEB_MODAL=1',
  );
  assert.doesNotMatch(
    webModalLayoutContents,
    /BaseStack/,
    'expo-router _web-modal.js should not fall back to the base stack when web modals are enabled',
  );
});

test('apps/ui patched expo-router web modal stack guards missing preloadedRoutes', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const modalStackPath = join(
    packageRoot,
    'node_modules',
    'expo-router',
    'build',
    'modal',
    'web',
    'ModalStack.js',
  );
  const modalStackContents = await readFile(modalStackPath, 'utf-8');

  assert.match(
    modalStackContents,
    /preloadedRoutes:\s*state\.preloadedRoutes\s*\?\?\s*\[\]/,
    'expo-router ModalStack.js should default missing preloadedRoutes to an empty array before rendering NativeStackView',
  );
});

test('apps/ui postinstall verifies the current expo-router web modal patch target', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const postinstallPath = join(packageRoot, 'tools', 'postinstall.mjs');
  const postinstallContents = await readFile(postinstallPath, 'utf-8');

  assert.match(
    postinstallContents,
    /build['"], ['"]layouts['"], ['"]_web-modal\.js/,
    'postinstall should verify the Expo Router web modal layout patch target',
  );
  assert.match(
    postinstallContents,
    /ExperimentalModalStack/,
    'postinstall should verify the experimental modal stack marker',
  );
  assert.match(
    postinstallContents,
    /build['"], ['"]modal['"], ['"]web['"], ['"]ModalStack\.js/,
    'postinstall should verify the Expo Router ModalStack patch target used by Expo Router 55',
  );
  assert.match(
    postinstallContents,
    /preloadedRoutes: state\.preloadedRoutes \?\? \[\]/,
    'postinstall should verify the preloadedRoutes ModalStack guard',
  );
});

test('apps/ui postinstall verifies enriched-markdown web WASM streaming patch targets', async () => {
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const postinstallPath = join(packageRoot, '..', 'tools', 'postinstall.mjs');
  const postinstallContents = await readFile(postinstallPath, 'utf-8');

  assert.match(postinstallContents, /install-react-native-enriched-markdown-web-wasm/);
  assert.match(postinstallContents, /md4c\.esm\.single-file\.js/);
  assert.match(postinstallContents, /src['"], ['"]web['"], ['"]parseMarkdown\.ts/);
  assert.match(postinstallContents, /lengthBytesUTF8\(markdown\)/);
  assert.match(postinstallContents, /SINGLE_FILE_BINARY_ENCODE=0/);
  assert.match(postinstallContents, /export default createMd4cModule/);
});

test('apps/ui patched expo-router native stack treats unavailable liquid glass as disabled', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const nativeStackPath = join(
    packageRoot,
    'node_modules',
    'expo-router',
    'build',
    'fork',
    'native-stack',
    'createNativeStackNavigator.js',
  );
  const nativeStackContents = await readFile(nativeStackPath, 'utf-8');

  assert.match(
    nativeStackContents,
    /function\s+isLiquidGlassNavigatorAvailable\(\)\s*{[\s\S]*try\s*{[\s\S]*isLiquidGlassAvailable[\s\S]*}\s*catch\s*{[\s\S]*return false;/,
    'expo-router native stack should not crash when ExpoGlassEffect is unavailable in a dev client',
  );
  assert.match(
    nativeStackContents,
    /require\("expo-glass-effect\/build\/isLiquidGlassAvailable"\)/,
    'expo-router native stack should import only the liquid-glass availability helper',
  );
  assert.doesNotMatch(
    nativeStackContents,
    /require\("expo-glass-effect"\)/,
    'expo-router native stack should avoid the expo-glass-effect root export side effects',
  );
  assert.doesNotMatch(
    nativeStackContents,
    /const GLASS = \(0, expo_glass_effect_1\.isLiquidGlassAvailable\)\(\);/,
    'expo-router native stack should not eagerly require ExpoGlassEffect without a fallback',
  );
});

test('apps/ui patched expo-crypto root import avoids eager AES native module loading', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));

  const cryptoPathCandidates = [
    join(packageRoot, 'node_modules', 'expo-crypto', 'build', 'Crypto.js'),
    join(repoRoot, 'node_modules', 'expo-crypto', 'build', 'Crypto.js'),
  ];
  let cryptoContents = '';
  for (const candidate of cryptoPathCandidates) {
    try {
      cryptoContents = await readFile(candidate, 'utf-8');
      break;
    } catch {
    }
  }

  assert.notEqual(cryptoContents, '', 'expo-crypto Crypto.js should exist in app or root node_modules');

  assert.doesNotMatch(
    cryptoContents,
    /export\s+\*\s+from\s+['"]\.\/aes['"]/,
    'expo-crypto root import should not eagerly load ExpoCryptoAES when only digest/random helpers are used',
  );
  assert.doesNotMatch(
    cryptoContents,
    /ExpoCryptoAES/,
    'expo-crypto root import should not mention the AES native module',
  );
});

test('apps/ui uses a React Native 0.83 compatible react-native-unistyles release', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const directUnistylesRange = packageJson?.dependencies?.['react-native-unistyles'];
  const installedUnistylesPackageJson = await readJson(
    join(packageRoot, 'node_modules', 'react-native-unistyles', 'package.json'),
  );

  assert.equal(typeof directUnistylesRange, 'string');

  assert.equal(
    semver.gte(semver.minVersion(directUnistylesRange), '3.2.4'),
    true,
    `apps/ui declares react-native-unistyles ${directUnistylesRange}, but Expo SDK 55 / React Native 0.83 needs 3.2.4 or newer`,
  );
  assert.equal(
    semver.gte(installedUnistylesPackageJson.version, '3.2.4'),
    true,
    `apps/ui installed react-native-unistyles ${installedUnistylesPackageJson.version}, but Expo SDK 55 / React Native 0.83 needs 3.2.4 or newer`,
  );
});

test('apps/ui keeps Nitro Modules native and JS versions compatible with React Native 0.83', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const directNitroRange = packageJson?.dependencies?.['react-native-nitro-modules'];
  const installedNitroPackageJson = await readJson(
    join(packageRoot, 'node_modules', 'react-native-nitro-modules', 'package.json'),
  );
  const podfileLockContents = await readFile(join(packageRoot, 'ios', 'Podfile.lock'), 'utf-8');
  const lockedNitroPodVersion = readPodVersion(podfileLockContents, 'NitroModules');

  assert.equal(typeof directNitroRange, 'string');

  assert.equal(
    semver.gte(semver.minVersion(directNitroRange), '0.35.6'),
    true,
    `apps/ui declares react-native-nitro-modules ${directNitroRange}, but React Native 0.83 native builds need 0.35.6 or newer`,
  );
  assert.equal(
    semver.satisfies(installedNitroPackageJson.version, directNitroRange),
    true,
    `apps/ui installed react-native-nitro-modules ${installedNitroPackageJson.version}, but package.json declares ${directNitroRange}`,
  );
  assert.equal(
    lockedNitroPodVersion,
    installedNitroPackageJson.version,
    `apps/ui iOS Podfile.lock resolves NitroModules ${lockedNitroPodVersion}, but JS uses react-native-nitro-modules ${installedNitroPackageJson.version}`,
  );
});
