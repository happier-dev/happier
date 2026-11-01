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

const TASK_MANAGER_ANDROID_PATCH = `--- a/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java
+++ b/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java
@@ -1,3 +1,4 @@
+// Keep React Native timers active during the background task.
`;

const TASK_MANAGER_JS_PATCH = `--- a/node_modules/expo-task-manager/src/TaskManager.ts
+++ b/node_modules/expo-task-manager/src/TaskManager.ts
@@ -1,3 +1,4 @@
+// Register the Android headless task callback.
`;

const NOTIFICATIONS_ANDROID_PATCH = `--- a/node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/service/delegates/ExpoHandlingDelegate.kt
+++ b/node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/service/delegates/ExpoHandlingDelegate.kt
@@ -1,3 +1,4 @@
+// Use foreground startup for the default notification tap.
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
        'patches/expo-task-manager+14.0.9.patch': TASK_MANAGER_JS_PATCH,
        'app.config.js': APP_CONFIG_WITHOUT_SOURCE_BUILD,
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});

test('requires source compilation for the patched Expo TaskManager Android implementation', () => {
    const uiDir = createUiDir({
        'patches/expo-task-manager+14.0.9.patch': TASK_MANAGER_ANDROID_PATCH,
        'package.json': JSON.stringify({ expo: { autolinking: { searchPaths: ['../../node_modules', './node_modules'] } } }),
    });

    const missingConfig = verifyNativePatchCompilation({ uiDir });
    assert.equal(missingConfig.ok, false);
    assert.equal(missingConfig.errors.length, 1);
    assert.match(missingConfig.errors[0], /expo\.autolinking\.android\.buildFromSource/);
    assert.match(missingConfig.errors[0], /TaskService\.java/);

    for (const [project, expected] of [['expo-task-manager-extra', false], ['expo-task-manager', true]]) {
        fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({
            expo: { autolinking: { android: { buildFromSource: [project, 'unimodules-app-loader'] } } },
        }));
        const configured = verifyNativePatchCompilation({ uiDir });
        assert.equal(configured.ok, expected);
        assert.equal(configured.errors.length, expected ? 0 : 1);
    }
});

test('requires the loader Gradle project used by TaskManager when compiling its patch from source', () => {
    const uiDir = createUiDir({
        'patches/expo-task-manager+14.0.9.patch': TASK_MANAGER_ANDROID_PATCH,
        'package.json': JSON.stringify({
            expo: { autolinking: { android: { buildFromSource: ['expo-task-manager'] } } },
        }),
    });

    const result = verifyNativePatchCompilation({ uiDir });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /unimodules-app-loader/);
});

test('requires source compilation for the patched Expo Notifications Android implementation', () => {
    const buildFromSource = ['expo-task-manager', 'unimodules-app-loader'];
    const uiDir = createUiDir({
        'patches/expo-notifications+0.32.16.patch': NOTIFICATIONS_ANDROID_PATCH,
        'package.json': JSON.stringify({ expo: { autolinking: { android: { buildFromSource } } } }),
    });

    const missingConfig = verifyNativePatchCompilation({ uiDir });
    assert.equal(missingConfig.ok, false);
    assert.equal(missingConfig.errors.length, 1);
    assert.match(missingConfig.errors[0], /expo-notifications/);
    assert.match(missingConfig.errors[0], /ExpoHandlingDelegate\.kt/);

    fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({
        expo: { autolinking: { android: { buildFromSource: [...buildFromSource, 'expo-notifications'] } } },
    }));
    assert.equal(verifyNativePatchCompilation({ uiDir }).ok, true);
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
