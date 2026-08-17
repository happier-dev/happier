/** @moduleRealm build */
import {
    PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS,
    PluginUiArtifactsManifestEntryV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiArtifactFileV1,
    PluginUiArtifactsManifestEntryV1,
    PluginUiHostNativeRuntimeExternalSpecifierV1,
} from './publicContract.js';

import {
    readOutputPathSegment,
    readRelativeBuildPath,
    readRequiredString,
} from './buildPaths.js';

type ReactNativeBundleBuildPlatform = 'ios' | 'android';

const HOST_API_CLIENT_EXTERNAL = '@happier-dev/plugin-sdk/ui/client';
const REACT_NATIVE_BUNDLES_FEATURE_ID: 'plugins.ui.reactNativeBundles' = 'plugins.ui.reactNativeBundles';
const REACT_NATIVE_BUNDLE_REQUIRED_FEATURE_IDS = Object.freeze([REACT_NATIVE_BUNDLES_FEATURE_ID] as const);
/**
 * EU-6: the host-provided singleton closure is owned once, by
 * `PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS`
 * (`packages/protocol/src/plugins/ui/hostRuntimeExternals.ts`), and consumed
 * verbatim here and by `apps/ui`'s Module Federation host share scope. It was
 * previously appended to locally, which is exactly how the build came to
 * externalize Reanimated and React Navigation with `import:false` against a
 * host that provided neither (UI-D14).
 */
const REPACK_SHARED_SINGLETONS: readonly PluginUiHostNativeRuntimeExternalSpecifierV1[] =
    PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS;
const REPACK_EXTERNALS: readonly (
    | PluginUiHostNativeRuntimeExternalSpecifierV1
    | typeof HOST_API_CLIENT_EXTERNAL
)[] = Object.freeze([
    ...REPACK_SHARED_SINGLETONS,
    HOST_API_CLIENT_EXTERNAL,
] as const);

const REPACK_SHARED_MODULE_CONFIG: Readonly<{
    singleton: true;
    eager: false;
    import: false;
}> = Object.freeze({
    singleton: true,
    eager: false,
    import: false,
});

/**
 * Re.Pack 5.2's platform defaults deliberately leave `exportsFields` empty.
 * That bypasses standard package-subpath exports and makes an external author
 * build unable to resolve public SDK leaves such as
 * `@happier-dev/plugin-sdk/actions`. Preserve every Re.Pack platform option,
 * but restore the standard package-exports resolver for plugin source.
 */
const REPACK_PACKAGE_EXPORTS_FIELDS: readonly ['exports'] = Object.freeze(['exports'] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deriveNodeNextExtensionAlias(options: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
    if (!isRecord(options.extensionAlias) || !Array.isArray(options.extensions)) return undefined;
    const authorExtensions = options.extensions.filter(
        (extension): extension is string => typeof extension === 'string'
            && /\.(?:js|jsx|ts|tsx)$/u.test(extension),
    );
    if (authorExtensions.length === 0) return undefined;

    const javascriptExtensions = authorExtensions.filter((extension) => /\.(?:js|jsx)$/u.test(extension));
    const typedExtensions = authorExtensions.filter((extension) => /\.(?:ts|tsx)$/u.test(extension));
    // Re.Pack lists TypeScript and TSX together by source extension, which would
    // let a generic `.ts` file win before a platform-specific `.tsx` file. Keep
    // Re.Pack's platform order, but group each platform's TS/TSX pair together
    // so platform/native precedence remains authoritative for author fallbacks.
    const typedPlatformSuffixes = [...new Set(typedExtensions.map((extension) => (
        extension.replace(/\.(?:ts|tsx)$/u, '')
    )))];
    const typedExtensionsByPlatform = typedPlatformSuffixes.flatMap((platformSuffix) => (
        typedExtensions.filter((extension) => extension.replace(/\.(?:ts|tsx)$/u, '') === platformSuffix)
    ));
    return Object.freeze({
        ...options.extensionAlias,
        // JavaScript/JSX sources retain Re.Pack's original first-position
        // priority; grouped TypeScript/TSX entries are the NodeNext fallbacks.
        '.js': Object.freeze([...javascriptExtensions, ...typedExtensionsByPlatform]),
    });
}

export type ReactNativeRepackSharedModules = Readonly<Record<
    PluginUiHostNativeRuntimeExternalSpecifierV1,
    Readonly<{
        singleton: true;
        eager: false;
        import: false;
    }>
>>;

const REPACK_SHARED_MODULES: ReactNativeRepackSharedModules = Object.freeze(Object.fromEntries(
    REPACK_SHARED_SINGLETONS.map((specifier) => [specifier, REPACK_SHARED_MODULE_CONFIG]),
) as ReactNativeRepackSharedModules);

/**
 * Generates the exact Module Federation shared map used by a Re.Pack plugin
 * author config. Every entry is a host-provided singleton with no bundled
 * fallback; unknown React subpaths are intentionally not matched.
 */
export function createReactNativeRepackSharedModules(): ReactNativeRepackSharedModules {
    return REPACK_SHARED_MODULES;
}

/**
 * Applies the SDK's package-resolution contract to Re.Pack's platform
 * defaults. Authors pass `Repack.getResolveOptions(platform)` here rather
 * than copying resolver fields into each config. Logical symlink paths are
 * retained so emitted native artifact identities cannot depend on the
 * physical pack/staging root.
 */
export function createReactNativeRepackResolveOptions<
    TOptions extends Readonly<Record<string, unknown>>,
>(options: TOptions): Omit<TOptions, 'exportsFields' | 'symlinks'> & Readonly<{
    exportsFields: typeof REPACK_PACKAGE_EXPORTS_FIELDS;
    symlinks: false;
}> {
    const extensionAlias = deriveNodeNextExtensionAlias(options);
    return Object.freeze({
        ...options,
        exportsFields: REPACK_PACKAGE_EXPORTS_FIELDS,
        symlinks: false,
        ...(extensionAlias === undefined ? {} : { extensionAlias }),
    }) as Omit<TOptions, 'exportsFields' | 'symlinks'> & Readonly<{
        exportsFields: typeof REPACK_PACKAGE_EXPORTS_FIELDS;
        symlinks: false;
    }>;
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
    /** Native derives container/module from `module`; only the private export varies. */
    collectionMigrations?: Readonly<{ exportName: string }>;
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
    /** Native derives container/module from `module`; only the private export varies. */
    collectionMigrations?: Readonly<{ exportName: string }>;
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
    collectionMigrations?: Readonly<{ exportName: string }>;
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
        ...(input.collectionMigrations ? {
            collectionMigrations: {
                containerName: readRequiredString(input.module.containerName, 'module.containerName'),
                modulePath: readRequiredString(input.module.modulePath, 'module.modulePath'),
                exportName: readRequiredString(
                    input.collectionMigrations.exportName,
                    'collectionMigrations.exportName',
                ),
            },
        } : {}),
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
        ...(input.collectionMigrations ? {
            collectionMigrations: Object.freeze({
                exportName: readRequiredString(
                    input.collectionMigrations.exportName,
                    'collectionMigrations.exportName',
                ),
            }),
        } : {}),
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
    PluginUiHostNativeRuntimeExternalSpecifierV1,
    PluginUiArtifactsManifestEntryV1,
} from './publicContract.js';
