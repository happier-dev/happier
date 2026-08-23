import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

const require = createRequire(import.meta.url);
const { parsePatchFile } = require('patch-package/dist/patch/parse');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function readPodVersion(podfileLockContents, podName) {
  const escapedPodName = podName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = podfileLockContents.match(new RegExp(`^  - ${escapedPodName} \\(([^)]+)\\):?`, 'm'));
  return match?.[1] ?? null;
}

test('apps/ui vendor patches are syntactically valid patch-package inputs', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const patchDir = join(dirname(scriptsDir), 'patches');
  const patchFileNames = (await readdir(patchDir)).filter((fileName) => fileName.endsWith('.patch'));

  assert.ok(patchFileNames.length > 0, 'expected at least one UI vendor patch');
  for (const patchFileName of patchFileNames) {
    const patchContents = await readFile(join(patchDir, patchFileName), 'utf-8');
    assert.doesNotThrow(
      () => parsePatchFile(patchContents),
      `${patchFileName} must be parseable by the patch-package version used by postinstall`,
    );
  }
});

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

test('apps/ui fast test lane is read-only and leaves patch/vendor mutation to install', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const testScript = packageJson?.scripts?.test;
  const localTestScript = packageJson?.scripts?.['test:local'];
  const unitTestScript = packageJson?.scripts?.['test:unit'];
  const localUnitTestScript = packageJson?.scripts?.['test:unit:local'];
  const installScript = packageJson?.scripts?.['postinstall:real'];

  assert.equal(typeof testScript, 'string');
  assert.match(testScript, /--script=test:local/);
  assert.equal(typeof localTestScript, 'string');
  assert.match(localTestScript, /\btest:unit:local\b/);
  assert.match(localTestScript, /navigationPackageContract\.test\.mjs/);
  assert.match(
    localTestScript,
    /verifyReactNativeEnrichedMarkdownWebStreamingPatch\.test\.mjs/,
    'the full UI test lane should verify the patched enriched-markdown web streaming artifacts',
  );
  assert.equal(packageJson?.scripts?.['postinstall:patches'], undefined);
  assert.match(installScript, /tools\/postinstall\.mjs/);
  assert.equal(typeof unitTestScript, 'string');
  assert.match(unitTestScript, /--script=test:unit:local/);
  assert.equal(typeof localUnitTestScript, 'string');
  assert.doesNotMatch(localUnitTestScript, /\bpostinstall(?::patches)?\b/);
  assert.match(localUnitTestScript, /runVitestShards\.mjs/);
});

test('apps/ui source validation does not prepare workspace runtime packages', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const scripts = packageJson?.scripts ?? {};

  for (const scriptName of [
    'test:unit:local',
    'test:integration:local',
    'test:integration:legend-native:local',
    'test:integration:legend-fabric:local',
    'test:activity-surfaces:local',
    'typecheck:local',
    'typecheck:activity-surfaces:local',
  ]) {
    const command = scripts[scriptName];
    assert.equal(typeof command, 'string', `${scriptName} must have a local source-validation command`);
    assert.doesNotMatch(command, /ensure:workspace:built|ensureWorkspacePackagesBuilt|syncSharedDepsForSourceDev|buildSharedDeps/);
  }

  assert.match(scripts.start, /ensure:workspace:built/);
  assert.match(scripts['tauri:dev'], /ensure:workspace:built/);
  assert.match(scripts['test:native-e2e:activity-surfaces'], /ensure:workspace:built/);
});

test('apps/ui declares patch and vendor sources as install freshness inputs', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const freshnessInputs = packageJson?.happier?.installFreshnessInputs;

  assert.ok(Array.isArray(freshnessInputs));
  assert.ok(freshnessInputs.includes('patches'));
  assert.ok(freshnessInputs.includes('tools/postinstall.mjs'));
  assert.ok(freshnessInputs.includes('tools/resolveUiPostinstallTasks.mjs'));
  assert.ok(freshnessInputs.includes('tools/react-native-enriched-markdown'));
  assert.ok(freshnessInputs.includes('tools/diffs'));
  assert.ok(freshnessInputs.includes('tools/codemirror'));
  assert.ok(freshnessInputs.includes('tools/xterm'));
  assert.ok(freshnessInputs.includes('tools/tiptap'));
  for (const relativePath of freshnessInputs) {
    await assert.doesNotReject(
      () => stat(join(packageRoot, relativePath)),
      `install freshness input must exist: ${relativePath}`,
    );
  }
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

test('apps/ui patched expo-router web modal keeps critical layout when Metro omits CSS-module injection', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const modalRouteDrawerPath = join(
    packageRoot,
    'node_modules',
    'expo-router',
    'build',
    'modal',
    'web',
    'ModalStackRouteDrawer.js',
  );
  const modalRouteDrawerContents = await readFile(modalRouteDrawerPath, 'utf-8');

  assert.match(
    modalRouteDrawerContents,
    /HAPPIER PATCH\(expo-router-web-modal-critical-inline-layout\)/,
    'Expo Router web route modals should retain an owner marker for the Metro CSS-module fallback',
  );
  assert.match(
    modalRouteDrawerContents,
    /criticalDrawerContentStyle/,
    'the route-modal drawer should keep its fixed viewport boundary without relying only on CSS modules',
  );
  assert.match(
    modalRouteDrawerContents,
    /criticalModalDesktopStyle/,
    'desktop route-modal content should keep its centered interactive card boundary',
  );
  assert.match(
    modalRouteDrawerContents,
    /criticalModalBodyStyle/,
    'route-modal screen content should remain a scrollable interactive body',
  );
  assert.match(
    modalRouteDrawerContents,
    /const modalAccessibilityTitle = typeof options\.title === 'string'/,
    'route-modal dialogs should derive their accessible title from the route options',
  );
  assert.match(
    modalRouteDrawerContents,
    /Drawer\.Title[^>]*>\{modalAccessibilityTitle\}<\/vaul_1\.Drawer\.Title>/,
    'route-modal dialogs should expose the derived route title to the Drawer accessibility owner',
  );
});

test('apps/ui patched expo-router linking rolls browser history back when route removal is prevented', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const useLinkingPath = join(
    packageRoot,
    'node_modules',
    'expo-router',
    'build',
    'fork',
    'useLinking.js',
  );
  const useLinkingContents = await readFile(useLinkingPath, 'utf-8');

  assert.match(
    useLinkingContents,
    /rollbackHistoryIfPrevented/,
    'expo-router useLinking should preserve the React Navigation history rollback owner',
  );
  assert.match(
    useLinkingContents,
    /__unsafe_event__[\s\S]*beforeRemove[\s\S]*defaultPrevented/,
    'expo-router useLinking should observe prevented route removals before committing browser history',
  );
  assert.match(
    useLinkingContents,
    /history\.go\(delta\)/,
    'expo-router useLinking should replay the exact inverse browser-history delta after prevention',
  );
  assert.match(
    useLinkingContents,
    /pendingPopStateDeltaRef/,
    'expo-router useLinking should account for the browser delta when a prevented action synchronously continues',
  );
  assert.match(
    useLinkingContents,
    /CommonActions\.goBack\(\)/,
    'expo-router useLinking should dispatch a real back action through the navigation removal owner',
  );
  assert.match(
    useLinkingContents,
    /previousState === rootState/,
    'expo-router useLinking should compare unchanged navigation state at the internal-slot root owner',
  );
  assert.match(
    useLinkingContents,
    /record\?\.path === path/,
    'expo-router useLinking should preserve the existing hash-only traversal branch',
  );
  assert.match(
    useLinkingContents,
    /const currentState = store\.state \?\? navigation\.getRootState\(\)/,
    'expo-router useLinking should compare its focused history records with the focused store state',
  );
  assert.match(
    useLinkingContents,
    /HAPPIER PATCH\(expo-router-root-focused-history-ownership\)/,
    'expo-router useLinking should expose a durable marker for the root/focused history ownership patch',
  );
  assert.match(
    useLinkingContents,
    /previousStateRef\.current = rootState/,
    'expo-router useLinking should retain internal-slot root state for ordinary in-app history synchronization',
  );
  assert.match(
    useLinkingContents,
    /findMatchingState\(previousState, rootState\)/,
    'expo-router useLinking should compute in-app history deltas from like-shaped internal-slot root states',
  );
  assert.doesNotMatch(
    useLinkingContents,
    /history\.go\(historyDelta\)/,
    'expo-router useLinking should not apply a focused-state delta to unrelated document history',
  );
});

test('apps/ui patched expo-router memory history settles rollback against the resolved entry', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const memoryHistoryPath = join(
    packageRoot,
    'node_modules',
    'expo-router',
    'build',
    'fork',
    'createMemoryHistory.js',
  );
  const memoryHistoryContents = await readFile(memoryHistoryPath, 'utf-8');

  assert.match(
    memoryHistoryContents,
    /const foundIndex = pending\.findIndex/,
    'expo-router createMemoryHistory should not shadow the mutable history index in its timeout fallback',
  );
  assert.match(
    memoryHistoryContents,
    /pending\[foundIndex\]\?\.cb\(\)/,
    'expo-router createMemoryHistory should settle the matching pending rollback callback',
  );
  assert.match(
    memoryHistoryContents,
    /index = this\.index/,
    'expo-router createMemoryHistory should resynchronize its internal index after rollback',
  );
});

test('apps/ui postinstall verifies every current expo-router patch target', async () => {
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
  assert.match(
    postinstallContents,
    /build['"], ['"]modal['"], ['"]web['"], ['"]ModalStackRouteDrawer\.js/,
    'postinstall should verify the Expo Router web route-modal drawer patch target',
  );
  assert.match(
    postinstallContents,
    /HAPPIER PATCH\(expo-router-web-modal-critical-inline-layout\)/,
    'postinstall should verify the critical inline route-modal layout marker',
  );
  assert.match(
    postinstallContents,
    /build['"], ['"]fork['"], ['"]useLinking\.js/,
    'postinstall should verify the Expo Router linking patch target',
  );
  assert.match(
    postinstallContents,
    /rollbackHistoryIfPrevented/,
    'postinstall should verify the prevented-removal browser-history marker',
  );
  assert.match(
    postinstallContents,
    /const currentState = store\.state \?\? navigation\.getRootState\(\)/,
    'postinstall should verify Expo Router focused-state history ownership',
  );
  assert.match(
    postinstallContents,
    /previousStateRef\.current = rootState/,
    'postinstall should verify ordinary Expo in-app history retains its internal-slot comparison owner',
  );
  assert.match(
    postinstallContents,
    /forbiddenMarkers:\s*\[['"]history\.go\(historyDelta\)['"]\]/,
    'postinstall should reject the unsafe focused-delta fallback',
  );
  assert.match(
    postinstallContents,
    /build['"], ['"]fork['"], ['"]createMemoryHistory\.js/,
    'postinstall should verify the Expo Router memory-history patch target',
  );
  assert.match(
    postinstallContents,
    /const foundIndex = pending\.findIndex/,
    'postinstall should verify the non-shadowing timeout fallback marker',
  );
  assert.match(
    postinstallContents,
    /build['"], ['"]fork['"], ['"]native-stack['"], ['"]createNativeStackNavigator\.js/,
    'postinstall should verify the Expo Router native-stack patch target',
  );
  assert.match(
    postinstallContents,
    /isLiquidGlassNavigatorAvailable/,
    'postinstall should verify the liquid-glass availability guard',
  );
});

test('apps/ui postinstall verifies enriched-markdown web WASM streaming patch targets', async () => {
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const postinstallPath = join(packageRoot, '..', 'tools', 'postinstall.mjs');
  const verifierPath = join(
    packageRoot,
    '..',
    'tools',
    'postinstall',
    'verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs',
  );
  const [postinstallContents, verifierContents] = await Promise.all([
    readFile(postinstallPath, 'utf-8'),
    readFile(verifierPath, 'utf-8'),
  ]);

  assert.match(postinstallContents, /install-react-native-enriched-markdown-web-wasm/);
  assert.match(postinstallContents, /md4c\.esm\.single-file\.js/);
  assert.match(postinstallContents, /verifyReactNativeEnrichedMarkdownWebStreamingPatch/);
  assert.match(verifierContents, /src\/web\/parseMarkdown\.ts/);
  assert.match(verifierContents, /lengthBytesUTF8\(markdown\)/);
  assert.match(verifierContents, /SINGLE_FILE_BINARY_ENCODE=0/);
  assert.match(verifierContents, /export default createMd4cModule/);
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
