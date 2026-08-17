/** @moduleRealm build */
import {
    PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
    PluginUiArtifactsManifestEntryV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiArtifactFileV1,
    PluginUiArtifactsManifestEntryV1,
    PluginUiHostRuntimeExternalSpecifierV1,
} from './publicContract.js';

import {
    readOutputPathSegment,
    readRelativeBuildPath,
    readRequiredString,
} from './buildPaths.js';
import {
    createPluginUiHostRuntimeExternalsVitePlugin,
} from './hostRuntimeExternalsBuildPlugin.js';
import {
    createPluginUiPackageInstanceVitePlugin,
} from './build/pluginUiPackageIdentity.js';

/**
 * RN-WEB-LOADER item 2 — LEDGER DEC-6: `reactNative` mode is the flagship
 * plugin-UI authoring path and MUST also render on web, via a
 * react-native-web federation build of the SAME `sourceEntry` used for the
 * ios/android Re.Pack build (`reactNativeBuild.ts`). One authoring model,
 * three manifest entries (ios/repack, android/repack, web/vite) — same
 * pattern already used for ios+android coexisting as separate entries.
 *
 * Bundle contract is intentionally IDENTICAL to the native Re.Pack contract
 * (`reactNativeBuild.ts` / `PluginReactNativeSurfaceModule`): the source
 * exports `renderSurface` as a named export, NOT via a `defaultExportFactory`
 * wrapper. React/RNW
 * singleton sharing does not need a factory-injection parameter here — the
 * `resolve.alias` (`react-native` -> `react-native-web`) plus the
 * host-runtime-externals virtual-module plugin (item 1,
 * `hostRuntimeExternalsBuildPlugin.ts`) make `import ... from 'react'` /
 * `'react-native-web'` resolve to the HOST's shared instance at module
 * evaluation time, with zero per-plugin author wrapping. This keeps ONE
 * authoring contract across native and web, per DEC-6.
 */

const REACT_NATIVE_BUNDLES_FEATURE_ID: 'plugins.ui.reactNativeBundles' = 'plugins.ui.reactNativeBundles';
const REACT_NATIVE_WEB_REQUIRED_FEATURE_IDS: readonly ['plugins.ui.reactNativeBundles'] =
    Object.freeze([REACT_NATIVE_BUNDLES_FEATURE_ID] as const);
const REACT_NATIVE_WEB_ALIAS: readonly [Readonly<{ find: 'react-native'; replacement: 'react-native-web' }>] = Object.freeze([
    Object.freeze({ find: 'react-native', replacement: 'react-native-web' }),
] as const);
const EMPTY_ROLLUP_EXTERNALS: readonly [] = Object.freeze([] as const);

export type ReactNativeWebViteBuildArtifactInput = Readonly<{
    contributionId: string;
    entry: string;
    files: readonly PluginUiArtifactFileV1[];
    digest: string;
    viteVersion: string;
    hostUiApiVersion: string;
    /** The web loader imports the entry module, so this is its only true module fact. */
    collectionMigrations?: Readonly<{ exportName: string }>;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
    }>;
}>;

export type ReactNativeWebViteBuildPresetInput = Readonly<{
    contributionId: string;
    sourceEntry: string;
    viteVersion: string;
    hostUiApiVersion: string;
    /** The web loader imports the entry module, so this is its only true module fact. */
    collectionMigrations?: Readonly<{ exportName: string }>;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
    }>;
}>;

export type ReactNativeWebViteBuildPreset = Readonly<{
    tier: 'reactNative';
    bundler: 'vite';
    contributionId: string;
    platform: 'web';
    sourceEntry: string;
    collectionMigrations?: Readonly<{ exportName: string }>;
    output: Readonly<{ root: string; entry: string }>;
    vite: Readonly<{
        version: string;
        mode: 'library';
        format: 'es';
        base: './';
        resolve: Readonly<{
            alias: readonly [Readonly<{ find: 'react-native'; replacement: 'react-native-web' }>];
        }>;
        hostRuntimeExternalSpecifiers: readonly PluginUiHostRuntimeExternalSpecifierV1[];
        external: readonly [];
        sourcemap: false;
    }>;
    compatibility: Readonly<{
        hostUiApiVersion: string;
        reactVersion: string;
        reactNativeVersion: string;
    }>;
    requiredFeatureIds: readonly ['plugins.ui.reactNativeBundles'];
    runtime: Readonly<{
        kind: 'hostGated';
        requiredFeatureId: 'plugins.ui.reactNativeBundles';
    }>;
}>;

export function defineReactNativeWebViteBuildPreset(
    input: ReactNativeWebViteBuildPresetInput,
): ReactNativeWebViteBuildPreset {
    const parsed = {
        contributionId: readOutputPathSegment(input.contributionId, 'contributionId'),
        sourceEntry: readRelativeBuildPath(input.sourceEntry, 'sourceEntry'),
        viteVersion: readRequiredString(input.viteVersion, 'viteVersion'),
        hostUiApiVersion: readRequiredString(input.hostUiApiVersion, 'hostUiApiVersion'),
        reactVersion: readRequiredString(input.compatibility.reactVersion, 'compatibility.reactVersion'),
        reactNativeVersion: readRequiredString(
            input.compatibility.reactNativeVersion,
            'compatibility.reactNativeVersion',
        ),
        ...(input.collectionMigrations ? {
            collectionMigrations: readRequiredString(
                input.collectionMigrations.exportName,
                'collectionMigrations.exportName',
            ),
        } : {}),
    };
    return Object.freeze({
        tier: 'reactNative',
        bundler: 'vite',
        contributionId: parsed.contributionId,
        platform: 'web',
        sourceEntry: parsed.sourceEntry,
        ...(parsed.collectionMigrations ? {
            collectionMigrations: Object.freeze({ exportName: parsed.collectionMigrations }),
        } : {}),
        output: Object.freeze({
            root: `dist/happier-plugin-ui/react-native-web/${parsed.contributionId}`,
            entry: `react-native-web/${parsed.contributionId}/entry.mjs`,
        }),
        vite: Object.freeze({
            version: parsed.viteVersion,
            mode: 'library',
            format: 'es',
            base: './',
            resolve: Object.freeze({ alias: REACT_NATIVE_WEB_ALIAS }),
            hostRuntimeExternalSpecifiers: PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
            external: EMPTY_ROLLUP_EXTERNALS,
            sourcemap: false,
        }),
        compatibility: Object.freeze({
            hostUiApiVersion: parsed.hostUiApiVersion,
            reactVersion: parsed.reactVersion,
            reactNativeVersion: parsed.reactNativeVersion,
        }),
        requiredFeatureIds: REACT_NATIVE_WEB_REQUIRED_FEATURE_IDS,
        runtime: Object.freeze({
            kind: 'hostGated',
            requiredFeatureId: REACT_NATIVE_BUNDLES_FEATURE_ID,
        }),
    });
}

/**
 * The managed UI builder installs these plugin instances in every generated
 * React Native Web Vite config, including when an author supplies an advanced
 * Vite extension. Direct Vite integrations may still use this helper, but a
 * `defineBuildConfig` author must not recreate the managed compiler path or
 * remember this guard themselves. Kept as a function (not baked into the
 * frozen data preset) so the preset itself stays a plain serializable
 * description, matching every other `define*BuildPreset` helper in this
 * file's siblings.
 */
export function createReactNativeWebVitePlugins(): readonly [
    ReturnType<typeof createPluginUiHostRuntimeExternalsVitePlugin>,
    ReturnType<typeof createPluginUiPackageInstanceVitePlugin>,
] {
    return [
        createPluginUiHostRuntimeExternalsVitePlugin({
            specifiers: PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
        }),
        createPluginUiPackageInstanceVitePlugin(),
    ] as const;
}

export function defineReactNativeWebViteBuildArtifact(
    input: ReactNativeWebViteBuildArtifactInput,
): PluginUiArtifactsManifestEntryV1 {
    const entry = readRelativeBuildPath(input.entry, 'entry');
    const files = input.files.map((file, index) => ({
        ...file,
        relativePath: readRelativeBuildPath(file.relativePath, `files[${index}].relativePath`),
    }));

    return PluginUiArtifactsManifestEntryV1Schema.parse({
        contributionId: readRequiredString(input.contributionId, 'contributionId'),
        tier: 'reactNative',
        platform: 'web',
        entry,
        files,
        digest: input.digest,
        builtWith: { bundler: 'vite', version: readRequiredString(input.viteVersion, 'viteVersion') },
        ...(input.collectionMigrations ? {
            collectionMigrations: {
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
        },
    });
}

export type {
    PluginUiHostRuntimeExternalSpecifierV1,
    PluginUiArtifactsManifestEntryV1,
} from './publicContract.js';
