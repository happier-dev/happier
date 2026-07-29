import {
    PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS,
    PluginUiArtifactsManifestEntryV1Schema,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    readOutputPathSegment,
    readRelativeBuildPath,
    readRequiredString,
} from './buildPaths.js';

type ReactNativeBundleBuildPlatform = 'ios' | 'android';

const HOST_API_CLIENT_EXTERNAL = '@happier-dev/plugin-sdk/ui/client';
const REACT_NATIVE_BUNDLES_FEATURE_ID = 'plugins.ui.reactNativeBundles';
const REACT_NATIVE_BUNDLE_REQUIRED_FEATURE_IDS = Object.freeze([REACT_NATIVE_BUNDLES_FEATURE_ID] as const);
const REPACK_SHARED_SINGLETONS = Object.freeze([
    ...PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS,
    'react-native',
    'react-native-reanimated',
    '@react-navigation/native',
    '@react-navigation/native-stack',
] as const);
const REPACK_EXTERNALS = Object.freeze([
    ...REPACK_SHARED_SINGLETONS,
    HOST_API_CLIENT_EXTERNAL,
] as const);

type ReactNativeRepackSharedModuleSpecifier = typeof REPACK_SHARED_SINGLETONS[number];

export type ReactNativeRepackSharedModuleConfig = Readonly<{
    singleton: true;
    eager: false;
    import: false;
}>;

export type ReactNativeRepackSharedModules = Readonly<
    Record<ReactNativeRepackSharedModuleSpecifier, ReactNativeRepackSharedModuleConfig>
>;

const REPACK_SHARED_MODULE_CONFIG: ReactNativeRepackSharedModuleConfig = Object.freeze({
    singleton: true,
    eager: false,
    import: false,
});

const REPACK_SHARED_MODULES = Object.freeze(Object.fromEntries(
    REPACK_SHARED_SINGLETONS.map((specifier) => [specifier, REPACK_SHARED_MODULE_CONFIG]),
) as Record<ReactNativeRepackSharedModuleSpecifier, ReactNativeRepackSharedModuleConfig>);

/**
 * Generates the exact Module Federation shared map used by a Re.Pack plugin
 * author config. Every entry is a host-provided singleton with no bundled
 * fallback; unknown React subpaths are intentionally not matched.
 */
export function createReactNativeRepackSharedModules(): ReactNativeRepackSharedModules {
    return REPACK_SHARED_MODULES;
}

export type ReactNativeBundleBuildArtifactInput = Readonly<{
    contributionId: string;
    platform: ReactNativeBundleBuildPlatform;
    entry: string;
    files: readonly PluginUiArtifactFileV1[];
    digest: string;
    repackVersion: string;
    hostUiApiVersion: string;
    module: ReactNativeRepackModuleIdentity;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
        expoRuntimeVersion?: string;
        hermesVersion?: string;
    }>;
}>;

export type ReactNativeRepackModuleIdentity = Readonly<{
    containerName: string;
    modulePath: string;
    exportName: string;
}>;

export type ReactNativeRepackBuildPresetInput = Readonly<{
    contributionId: string;
    platform: ReactNativeBundleBuildPlatform;
    sourceEntry: string;
    outputFileName?: string;
    repackVersion: string;
    hostUiApiVersion: string;
    module: ReactNativeRepackModuleIdentity;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
        expoRuntimeVersion?: string;
        hermesVersion?: string;
    }>;
}>;

export type ReactNativeRepackBuildPreset = Readonly<{
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
    module: ReactNativeRepackModuleIdentity;
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
    input: ReactNativeBundleBuildArtifactInput,
): PluginUiArtifactsManifestEntryV1 {
    const entry = readRelativeBuildPath(input.entry, 'entry');
    const files = input.files.map((file, index) => ({
        ...file,
        relativePath: readRelativeBuildPath(file.relativePath, `files[${index}].relativePath`),
    }));

    assertPlainJavaScriptBundlePath(entry);
    for (const file of files) {
        assertPlainJavaScriptBundlePath(file.relativePath);
    }

    return PluginUiArtifactsManifestEntryV1Schema.parse({
        contributionId: readRequiredString(input.contributionId, 'contributionId'),
        tier: 'reactNative',
        platform: input.platform,
        entry,
        files,
        digest: input.digest,
        builtWith: { bundler: 'repack', version: readRequiredString(input.repackVersion, 'repackVersion') },
        repack: {
            containerName: readRequiredString(input.module.containerName, 'module.containerName'),
            modulePath: readRequiredString(input.module.modulePath, 'module.modulePath'),
            exportName: readRequiredString(input.module.exportName, 'module.exportName'),
        },
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
    input: ReactNativeRepackBuildPresetInput,
): ReactNativeRepackBuildPreset {
    const contributionId = readOutputPathSegment(input.contributionId, 'contributionId');
    const sourceEntry = readRelativeBuildPath(input.sourceEntry, 'sourceEntry');
    const outputFileName = input.outputFileName
        ? readOutputPathSegment(input.outputFileName, 'outputFileName')
        : `${input.platform}.bundle.js`;
    assertPlainJavaScriptBundlePath(outputFileName);

    const module = input.module;
    return Object.freeze({
        tier: 'reactNative',
        bundler: 'repack',
        contributionId,
        platform: input.platform,
        sourceEntry,
        output: Object.freeze({
            root: `dist/happier-plugin-ui/react-native/${contributionId}`,
            entry: `react-native/${contributionId}/${input.platform}/${outputFileName}`,
        }),
        repack: Object.freeze({
            version: readRequiredString(input.repackVersion, 'repackVersion'),
            bundleFormat: 'plainJavaScript',
            hermesBytecode: false,
            external: REPACK_EXTERNALS,
            sharedSingletons: REPACK_SHARED_SINGLETONS,
            nativeModulePolicy: 'hostProvidedOnly',
        }),
        module: Object.freeze({
            containerName: readRequiredString(module.containerName, 'module.containerName'),
            modulePath: readRequiredString(module.modulePath, 'module.modulePath'),
            exportName: readRequiredString(module.exportName, 'module.exportName'),
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
