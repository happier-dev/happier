import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyNativePatchCompilation } from './verifyNativePatchCompilation.mjs';

const IOS_CORE_PATCH = `diff --git a/node_modules/react-native/React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm b/node_modules/react-native/React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm
index 1111111..2222222 100644
--- a/node_modules/react-native/React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm
+++ b/node_modules/react-native/React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm
@@ -1,3 +1,4 @@
+  // HAPPIER PATCH(composer-jiggle)
`;

const JS_ONLY_PATCH = `diff --git a/node_modules/react-native/Libraries/Text/TextInput/TextInput.js b/node_modules/react-native/Libraries/Text/TextInput/TextInput.js
--- a/node_modules/react-native/Libraries/Text/TextInput/TextInput.js
+++ b/node_modules/react-native/Libraries/Text/TextInput/TextInput.js
@@ -1,3 +1,4 @@
+// harmless js tweak
`;

const THIRD_PARTY_NATIVE_PATCH = `diff --git a/node_modules/react-native-unistyles/ios/UnistylesModuleOnLoad.mm b/node_modules/react-native-unistyles/ios/UnistylesModuleOnLoad.mm
--- a/node_modules/react-native-unistyles/ios/UnistylesModuleOnLoad.mm
+++ b/node_modules/react-native-unistyles/ios/UnistylesModuleOnLoad.mm
@@ -1,3 +1,4 @@
+// third-party pods still build from source
`;

const APP_CONFIG_WITH_SOURCE_BUILD = `const plugin = [
    "expo-build-properties",
    { android: {}, ios: { buildReactNativeFromSource: true, deploymentTarget: '16.0' } },
];
`;

const APP_CONFIG_WITHOUT_SOURCE_BUILD = `const plugin = [
    "expo-build-properties",
    { android: { usesCleartextTraffic: true } },
];
`;

function createUiDir(files) {
    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-patch-gate-'));
    for (const [relativePath, contents] of Object.entries(files)) {
        const target = path.join(uiDir, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents, 'utf8');
    }
    return uiDir;
}

test('passes when no patch touches React Native core native sources', () => {
    const uiDir = createUiDir({
        'patches/react-native+0.81.5.patch': JS_ONLY_PATCH,
        'patches/react-native-unistyles+3.2.4.patch': THIRD_PARTY_NATIVE_PATCH,
        'app.config.js': APP_CONFIG_WITHOUT_SOURCE_BUILD,
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});

test('fails when an iOS core patch exists but app.config.js does not declare a source build', () => {
    // The 2026-07-27 regression: the patch applies cleanly, every "is it applied?"
    // check passes, and prebuilt RNCore then compiles headers only.
    const uiDir = createUiDir({
        'patches/react-native+0.81.5.patch': IOS_CORE_PATCH,
        'app.config.js': APP_CONFIG_WITHOUT_SOURCE_BUILD,
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /buildReactNativeFromSource/);
    assert.match(result.errors[0], /RCTTextInputComponentView\.mm/);
    assert.match(result.errors[0], /app\.config\.js/);
});

test('passes with only the tracked declaration when no iOS project has been generated', () => {
    const uiDir = createUiDir({
        'patches/react-native+0.81.5.patch': IOS_CORE_PATCH,
        'app.config.js': APP_CONFIG_WITH_SOURCE_BUILD,
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
});

test('warns when a generated iOS project lacks the source-build property', () => {
    const uiDir = createUiDir({
        'patches/react-native+0.81.5.patch': IOS_CORE_PATCH,
        'app.config.js': APP_CONFIG_WITH_SOURCE_BUILD,
        'ios/Podfile.properties.json': JSON.stringify({ 'expo.jsEngine': 'hermes', newArchEnabled: 'true' }),
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Podfile\.properties\.json/);
    assert.match(result.warnings[0], /prebuild/);
});

test('warns when the generated Pods project does not compile a patched implementation file', () => {
    const uiDir = createUiDir({
        'patches/react-native+0.81.5.patch': IOS_CORE_PATCH,
        'app.config.js': APP_CONFIG_WITH_SOURCE_BUILD,
        'ios/Podfile.properties.json': JSON.stringify({ 'ios.buildReactNativeFromSource': 'true' }),
        // Headers only — exactly what prebuilt RNCore produces.
        'ios/Pods/Pods.xcodeproj/project.pbxproj': 'RCTTextInputComponentView.h in Headers',
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /RCTTextInputComponentView\.mm/);
    assert.match(result.warnings[0], /pod install/);
});

test('is silent when the generated project actually compiles the patched file', () => {
    const uiDir = createUiDir({
        'patches/react-native+0.81.5.patch': IOS_CORE_PATCH,
        'app.config.js': APP_CONFIG_WITH_SOURCE_BUILD,
        'ios/Podfile.properties.json': JSON.stringify({ 'ios.buildReactNativeFromSource': 'true' }),
        'ios/Pods/Pods.xcodeproj/project.pbxproj': 'RCTTextInputComponentView.mm in Sources',
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
});

test('fails for an Android core patch without an Android source-build declaration', () => {
    // react-android resolves from a Maven AAR, so an unpatched-at-compile-time
    // Android hunk fails exactly as silently as the iOS one did.
    const uiDir = createUiDir({
        'patches/react-native+0.81.5.patch': `--- a/node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.java
+++ b/node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.java
@@ -1,3 +1,4 @@
+// HAPPIER PATCH(android-thing)
`,
        'app.config.js': APP_CONFIG_WITH_SOURCE_BUILD,
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /ReactEditText\.java/);
    assert.match(result.errors[0], /android/);
});
