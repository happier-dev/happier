import {
    defineHostedWebViteBuildArtifact,
    defineHostedWebViteBuildPreset,
} from '@happier-dev/plugin-sdk/ui/hostedWebBuild';
import {
    defineReactNativeBundleBuildArtifact,
    defineReactNativeRepackBuildPreset,
} from '@happier-dev/plugin-sdk/ui/reactNativeBuild';
import {
    defineReactNativeWebViteBuildArtifact,
    defineReactNativeWebViteBuildPreset,
} from '@happier-dev/plugin-sdk/ui/reactNativeWebBuild';

const hostUiApiVersion = '1.0.0';
const reactVersion = '19.2.0';
const hostedWebDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const nativeWebDigest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const nativeIosDigest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

export const hostedWebPreset = defineHostedWebViteBuildPreset({
    contributionId: 'examples.publicSdk.reviewWeb',
    sourceEntry: 'ui/reviewPanel.web.tsx',
    viteVersion: '7.0.0',
    hostUiApiVersion,
    reactVersion,
});

export const hostedWebArtifact = defineHostedWebViteBuildArtifact({
    contributionId: hostedWebPreset.contributionId,
    entry: hostedWebPreset.output.entry,
    files: [
        hostedWebPreset.output.entry,
        'hosted-web/examples.publicSdk.reviewWeb/assets/app.js',
    ],
    digest: hostedWebDigest,
    viteVersion: hostedWebPreset.vite.version,
    hostUiApiVersion,
    reactVersion,
});

// RN-WEB-LOADER / LEDGER DEC-6: `reactNative` mode is the flagship authoring
// path and ALSO renders on web — the SAME `ui/reviewPanel.native.tsx` source
// used for the ios preset below compiles through a Vite + react-native-web
// federation build for the browser target. This replaces the retired
// `embeddedWeb` example target (its use case — in-process web rendering —
// is a strict subset of what reactNative-web now offers, for identical
// runtime cost, plus native support).
export const nativeWebPreset = defineReactNativeWebViteBuildPreset({
    contributionId: 'examples.publicSdk.reviewNative',
    sourceEntry: 'ui/reviewPanel.native.tsx',
    viteVersion: '7.3.1',
    hostUiApiVersion,
    compatibility: {
        reactVersion,
        reactNativeVersion: '0.83.4',
    },
});

export const nativeWebArtifact = defineReactNativeWebViteBuildArtifact({
    contributionId: nativeWebPreset.contributionId,
    entry: nativeWebPreset.output.entry,
    files: [nativeWebPreset.output.entry],
    digest: nativeWebDigest,
    viteVersion: nativeWebPreset.vite.version,
    hostUiApiVersion,
    compatibility: {
        reactVersion,
        reactNativeVersion: '0.83.4',
    },
});

export const nativeIosPreset = defineReactNativeRepackBuildPreset({
    contributionId: 'examples.publicSdk.reviewNative',
    platform: 'ios',
    sourceEntry: 'ui/reviewPanel.native.tsx',
    repackVersion: '5.0.0',
    hostUiApiVersion,
    compatibility: {
        reactVersion,
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
    },
});

export const nativeIosArtifact = defineReactNativeBundleBuildArtifact({
    contributionId: nativeIosPreset.contributionId,
    platform: nativeIosPreset.platform,
    entry: nativeIosPreset.output.entry,
    files: [nativeIosPreset.output.entry],
    digest: nativeIosDigest,
    repackVersion: nativeIosPreset.repack.version,
    hostUiApiVersion,
    compatibility: {
        reactVersion,
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
    },
});
