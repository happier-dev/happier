import fs from 'node:fs';
import path from 'node:path';

/**
 * A `patches/` entry that edits a React Native CORE native implementation file only
 * reaches a binary when that platform builds React Native from source. With the
 * prebuilt distributions (iOS `RCT_USE_PREBUILT_RNCORE`, Android's `react-android`
 * Maven AAR) the patch still applies to `node_modules` — so every "is the patch
 * applied?" check stays green — while the implementation is compiled from Meta's
 * artifacts and the fix silently disappears. That is how three Happier fixes
 * (composer caret reveal, composer jiggle, ScrollView MVCP) went dead in every iOS
 * binary for a week (2026-07-20 → 2026-07-27).
 *
 * The tracked declaration in `app.config.js` is the canonical owner, because every
 * prebuild path derives `ios/Podfile.properties.json` from it. This check enforces
 * that declaration and reports drift in the generated project.
 *
 * Errors vs warnings: a missing declaration is a defect in tracked repository state
 * and always fails. Generated `ios/**` artifacts are per-machine, absent on CI, and
 * self-heal on the next prebuild — they warn loudly rather than blocking an install
 * (this checkout is shared, and a failed `yarn install` would block unrelated work).
 */

const IOS_IMPLEMENTATION_EXTENSIONS = new Set(['.m', '.mm', '.swift']);
const ANDROID_IMPLEMENTATION_EXTENSIONS = new Set(['.java', '.kt']);
const SHARED_IMPLEMENTATION_EXTENSIONS = new Set(['.c', '.cc', '.cpp']);

const REACT_NATIVE_CORE_PREFIX = 'node_modules/react-native/';

function readPatchTargets(patchContents) {
    const targets = [];
    for (const line of patchContents.split('\n')) {
        if (!line.startsWith('+++ b/')) continue;
        const target = line.slice('+++ b/'.length).trim();
        if (!target || target === '/dev/null') continue;
        targets.push(target);
    }
    return targets;
}

function classifyTarget(target) {
    if (!target.startsWith(REACT_NATIVE_CORE_PREFIX)) return null;
    const extension = path.extname(target).toLowerCase();
    const isAndroidPath = target.includes('/ReactAndroid/') || target.includes('/android/');

    if (ANDROID_IMPLEMENTATION_EXTENSIONS.has(extension)) return 'android';
    if (IOS_IMPLEMENTATION_EXTENSIONS.has(extension)) return 'ios';
    if (SHARED_IMPLEMENTATION_EXTENSIONS.has(extension)) return isAndroidPath ? 'android' : 'ios';
    // Headers and JS/TS carry no compiled behavior of their own here.
    return null;
}

function collectCorePatchTargets(patchesDir) {
    if (!fs.existsSync(patchesDir)) return { ios: [], android: [] };

    const byPlatform = { ios: [], android: [] };
    for (const entry of fs.readdirSync(patchesDir).sort()) {
        if (!entry.endsWith('.patch')) continue;
        const contents = fs.readFileSync(path.join(patchesDir, entry), 'utf8');
        for (const target of readPatchTargets(contents)) {
            const platform = classifyTarget(target);
            if (platform) byPlatform[platform].push(target);
        }
    }
    return byPlatform;
}

function declaresSourceBuild(appConfigContents, platform) {
    // A structural read would mean evaluating app.config.js, which needs the Expo
    // env; the declaration is a single literal, so match it directly.
    const platformBlock = new RegExp(`${platform}\\s*:\\s*\\{[^}]*buildReactNativeFromSource\\s*:\\s*true`, 's');
    return platformBlock.test(appConfigContents);
}

function formatTargets(targets) {
    return targets.map((target) => `- ${target}`).join('\n');
}

export function verifyNativePatchCompilation({ uiDir }) {
    const errors = [];
    const warnings = [];

    const coreTargets = collectCorePatchTargets(path.join(uiDir, 'patches'));
    if (coreTargets.ios.length === 0 && coreTargets.android.length === 0) {
        return { ok: true, errors, warnings };
    }

    const appConfigPath = path.join(uiDir, 'app.config.js');
    const appConfigContents = fs.existsSync(appConfigPath) ? fs.readFileSync(appConfigPath, 'utf8') : '';

    for (const platform of ['ios', 'android']) {
        if (coreTargets[platform].length === 0) continue;
        if (declaresSourceBuild(appConfigContents, platform)) continue;
        errors.push(
            `patches/ edits React Native core ${platform} implementation files, but app.config.js does not declare\n`
            + `\`${platform}: { buildReactNativeFromSource: true }\` in its expo-build-properties plugin config.\n`
            + `Without it the patch applies to node_modules and is then discarded at compile time — the\n`
            + `${platform === 'ios' ? 'prebuilt RNCore xcframework' : 'com.facebook.react:react-android Maven artifact'} is what actually ships.\n`
            + `Patched implementation files:\n${formatTargets(coreTargets[platform])}`,
        );
    }

    if (coreTargets.ios.length === 0) {
        return { ok: errors.length === 0, errors, warnings };
    }

    const podfilePropertiesPath = path.join(uiDir, 'ios', 'Podfile.properties.json');
    if (fs.existsSync(podfilePropertiesPath)) {
        let podfileProperties = {};
        try {
            podfileProperties = JSON.parse(fs.readFileSync(podfilePropertiesPath, 'utf8'));
        } catch {
            podfileProperties = {};
        }
        if (podfileProperties['ios.buildReactNativeFromSource'] !== 'true') {
            warnings.push(
                `ios/Podfile.properties.json is missing "ios.buildReactNativeFromSource": "true", so the generated\n`
                + `project links prebuilt React Native core and the patches under patches/ are not compiled.\n`
                + `This generated project predates the app.config.js declaration — regenerate it:\n`
                + `  yarn prebuild && yarn ios`,
            );
        }
    }

    const pbxprojPath = path.join(uiDir, 'ios', 'Pods', 'Pods.xcodeproj', 'project.pbxproj');
    if (fs.existsSync(pbxprojPath)) {
        const pbxproj = fs.readFileSync(pbxprojPath, 'utf8');
        const uncompiled = coreTargets.ios.filter((target) => !pbxproj.includes(path.basename(target)));
        if (uncompiled.length > 0) {
            warnings.push(
                `The generated Pods project does not compile these patched implementation files:\n`
                + `${formatTargets(uncompiled)}\n`
                + `Their fixes are absent from any binary built from ios/. Regenerate the project:\n`
                + `  yarn prebuild && (cd ios && pod install)`,
            );
        }
    }

    return { ok: errors.length === 0, errors, warnings };
}
