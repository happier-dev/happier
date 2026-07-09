import {
    PluginUiArtifactsManifestEntryV1Schema,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    readOutputPathSegment,
    readRelativeBuildPath,
    readRequiredString,
} from './buildPaths.js';

type ReactNativeBundleBuildPlatform = 'ios' | 'android';

const HOST_API_CLIENT_EXTERNAL = '@happier-dev/plugin-sdk/ui/hostApiClient';
const REACT_NATIVE_BUNDLES_FEATURE_ID = 'plugins.ui.reactNativeBundles';
const REACT_NATIVE_BUNDLE_REQUIRED_FEATURE_IDS = Object.freeze([REACT_NATIVE_BUNDLES_FEATURE_ID] as const);
const REPACK_SHARED_SINGLETONS = Object.freeze([
    'react',
    'react-native',
    'react-native-reanimated',
    '@react-navigation/native',
    '@react-navigation/native-stack',
] as const);
const REPACK_EXTERNALS = Object.freeze([
    ...REPACK_SHARED_SINGLETONS,
    HOST_API_CLIENT_EXTERNAL,
] as const);

export type ReactNativeBundleBuildArtifactInputV1 = Readonly<{
    contributionId: string;
    platform: ReactNativeBundleBuildPlatform;
    entry: string;
    files: readonly string[];
    digest: string;
    repackVersion: string;
    hostUiApiVersion: string;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
        expoRuntimeVersion?: string;
        hermesVersion?: string;
    }>;
}>;

export type ReactNativeRepackBuildPresetInputV1 = Readonly<{
    contributionId: string;
    platform: ReactNativeBundleBuildPlatform;
    sourceEntry: string;
    outputFileName?: string;
    repackVersion: string;
    hostUiApiVersion: string;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
        expoRuntimeVersion?: string;
        hermesVersion?: string;
    }>;
}>;

export type ReactNativeRepackBuildPresetV1 = Readonly<{
    tier: 'reactNative';
    bundler: 'repack';
    contributionId: string;
    platform: ReactNativeBundleBuildPlatform;
    sourceEntry: string;
    output: Readonly<{
        root: string;
        entry: string;
    }>;
    repack: Readonly<{
        version: string;
        bundleFormat: 'plainJavaScript';
        hermesBytecode: false;
        external: typeof REPACK_EXTERNALS;
        sharedSingletons: typeof REPACK_SHARED_SINGLETONS;
        nativeModulePolicy: 'hostProvidedOnly';
    }>;
    compatibility: Readonly<{
        hostUiApiVersion: string;
        reactVersion: string;
        reactNativeVersion: string;
        expoRuntimeVersion?: string;
        hermesVersion?: string;
    }>;
    requiredFeatureIds: readonly [typeof REACT_NATIVE_BUNDLES_FEATURE_ID];
    runtime: Readonly<{
        kind: 'hostGated';
        requiredFeatureId: typeof REACT_NATIVE_BUNDLES_FEATURE_ID;
    }>;
}>;

function assertPlainJavaScriptBundlePath(path: string): void {
    if (/\.hbc(?:bundle)?$/iu.test(path)) {
        throw new Error('Hermes bytecode React Native artifacts are not supported yet; ship a plain JS bundle.');
    }
}

export function defineReactNativeBundleBuildArtifact(
    input: ReactNativeBundleBuildArtifactInputV1,
): PluginUiArtifactsManifestEntryV1 {
    const entry = readRelativeBuildPath(input.entry, 'entry');
    const files = input.files.map((file, index) => readRelativeBuildPath(file, `files[${index}]`));

    assertPlainJavaScriptBundlePath(entry);
    for (const file of files) {
        assertPlainJavaScriptBundlePath(file);
    }

    return PluginUiArtifactsManifestEntryV1Schema.parse({
        contributionId: readRequiredString(input.contributionId, 'contributionId'),
        tier: 'reactNative',
        platform: input.platform,
        entry,
        files,
        digest: input.digest,
        builtWith: { bundler: 'repack', version: readRequiredString(input.repackVersion, 'repackVersion') },
        hostUiApiVersion: readRequiredString(input.hostUiApiVersion, 'hostUiApiVersion'),
        compat: {
            react: readRequiredString(input.compatibility.reactVersion, 'compatibility.reactVersion'),
            reactNative: readRequiredString(
                input.compatibility.reactNativeVersion,
                'compatibility.reactNativeVersion',
            ),
            ...(input.compatibility.expoRuntimeVersion
                ? {
                    expoRuntime: readRequiredString(
                        input.compatibility.expoRuntimeVersion,
                        'compatibility.expoRuntimeVersion',
                    ),
                }
                : {}),
            ...(input.compatibility.hermesVersion
                ? {
                    hermes: readRequiredString(
                        input.compatibility.hermesVersion,
                        'compatibility.hermesVersion',
                    ),
                }
                : {}),
        },
    });
}

export function defineReactNativeRepackBuildPreset(
    input: ReactNativeRepackBuildPresetInputV1,
): ReactNativeRepackBuildPresetV1 {
    const contributionId = readOutputPathSegment(input.contributionId, 'contributionId');
    const sourceEntry = readRelativeBuildPath(input.sourceEntry, 'sourceEntry');
    const outputFileName = input.outputFileName
        ? readOutputPathSegment(input.outputFileName, 'outputFileName')
        : `${input.platform}.bundle.js`;
    assertPlainJavaScriptBundlePath(outputFileName);

    return Object.freeze({
        tier: 'reactNative',
        bundler: 'repack',
        contributionId,
        platform: input.platform,
        sourceEntry,
        output: Object.freeze({
            root: `dist/happier-plugin-ui/react-native/${contributionId}`,
            entry: `react-native/${contributionId}/${outputFileName}`,
        }),
        repack: Object.freeze({
            version: readRequiredString(input.repackVersion, 'repackVersion'),
            bundleFormat: 'plainJavaScript',
            hermesBytecode: false,
            external: REPACK_EXTERNALS,
            sharedSingletons: REPACK_SHARED_SINGLETONS,
            nativeModulePolicy: 'hostProvidedOnly',
        }),
        compatibility: Object.freeze({
            hostUiApiVersion: readRequiredString(input.hostUiApiVersion, 'hostUiApiVersion'),
            reactVersion: readRequiredString(input.compatibility.reactVersion, 'compatibility.reactVersion'),
            reactNativeVersion: readRequiredString(
                input.compatibility.reactNativeVersion,
                'compatibility.reactNativeVersion',
            ),
            ...(input.compatibility.expoRuntimeVersion
                ? {
                    expoRuntimeVersion: readRequiredString(
                        input.compatibility.expoRuntimeVersion,
                        'compatibility.expoRuntimeVersion',
                    ),
                }
                : {}),
            ...(input.compatibility.hermesVersion
                ? {
                    hermesVersion: readRequiredString(
                        input.compatibility.hermesVersion,
                        'compatibility.hermesVersion',
                    ),
                }
                : {}),
        }),
        requiredFeatureIds: REACT_NATIVE_BUNDLE_REQUIRED_FEATURE_IDS,
        runtime: Object.freeze({
            kind: 'hostGated',
            requiredFeatureId: REACT_NATIVE_BUNDLES_FEATURE_ID,
        }),
    });
}

export type {
    PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';
