import {
    PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
    PluginUiArtifactsManifestEntryV1Schema,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    readOutputPathSegment,
    readRelativeBuildPath,
    readRequiredString,
} from './buildPaths.js';
import {
    createPluginUiHostRuntimeExternalsVitePlugin,
    type PluginUiHostRuntimeExternalsVitePlugin,
} from './hostRuntimeExternalsBuildPlugin.js';

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
 * exports `renderSurface` (and optionally `acknowledgeHostRuntime`) as a
 * named export, NOT via a `defaultExportFactory` wrapper. React/RNW
 * singleton sharing does not need a factory-injection parameter here — the
 * `resolve.alias` (`react-native` -> `react-native-web`) plus the
 * host-runtime-externals virtual-module plugin (item 1,
 * `hostRuntimeExternalsBuildPlugin.ts`) make `import ... from 'react'` /
 * `'react-native-web'` resolve to the HOST's shared instance at module
 * evaluation time, with zero per-plugin author wrapping. This keeps ONE
 * authoring contract across native and web, per DEC-6.
 */

const REACT_NATIVE_BUNDLES_FEATURE_ID = 'plugins.ui.reactNativeBundles';
const REACT_NATIVE_WEB_REQUIRED_FEATURE_IDS = Object.freeze([REACT_NATIVE_BUNDLES_FEATURE_ID] as const);
const REACT_NATIVE_WEB_ALIAS = Object.freeze([
    Object.freeze({ find: 'react-native', replacement: 'react-native-web' }),
] as const);
const EMPTY_ROLLUP_EXTERNALS = Object.freeze([] as const);

export type ReactNativeWebViteBuildPresetInput = Readonly<{
    contributionId: string;
    sourceEntry: string;
    viteVersion: string;
    hostUiApiVersion: string;
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
    output: Readonly<{
        root: string;
        entry: string;
    }>;
    vite: Readonly<{
        version: string;
        mode: 'library';
        format: 'es';
        base: './';
        resolve: Readonly<{ alias: typeof REACT_NATIVE_WEB_ALIAS }>;
        /**
         * Logically external to the plugin author (they still write plain
         * `import ... from 'react'` / `'react-native'`), but NOT declared to
         * Rollup as `external` — `createReactNativeWebVitePlugins()` MUST be
         * included in the author's `vite.config.ts` `plugins` array; it
         * intercepts these specifiers and resolves them to a generated
         * virtual module instead, so the built output never contains an
         * unresolved bare specifier (RNWEB-SPIKE §Q1(c)).
         */
        hostRuntimeExternalSpecifiers: typeof PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS;
        external: readonly [];
        sourcemap: false;
    }>;
    compatibility: Readonly<{
        hostUiApiVersion: string;
        reactVersion: string;
        reactNativeVersion: string;
    }>;
    requiredFeatureIds: readonly [typeof REACT_NATIVE_BUNDLES_FEATURE_ID];
    runtime: Readonly<{
        kind: 'hostGated';
        requiredFeatureId: typeof REACT_NATIVE_BUNDLES_FEATURE_ID;
    }>;
}>;

export type ReactNativeWebViteBuildArtifactInput = Readonly<{
    contributionId: string;
    entry: string;
    files: readonly PluginUiArtifactFileV1[];
    digest: string;
    viteVersion: string;
    hostUiApiVersion: string;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
    }>;
}>;

function readPresetInput(input: ReactNativeWebViteBuildPresetInput) {
    return {
        contributionId: readOutputPathSegment(input.contributionId, 'contributionId'),
        sourceEntry: readRelativeBuildPath(input.sourceEntry, 'sourceEntry'),
        viteVersion: readRequiredString(input.viteVersion, 'viteVersion'),
        hostUiApiVersion: readRequiredString(input.hostUiApiVersion, 'hostUiApiVersion'),
        reactVersion: readRequiredString(input.compatibility.reactVersion, 'compatibility.reactVersion'),
        reactNativeVersion: readRequiredString(
            input.compatibility.reactNativeVersion,
            'compatibility.reactNativeVersion',
        ),
    };
}

export function defineReactNativeWebViteBuildPreset(
    input: ReactNativeWebViteBuildPresetInput,
): ReactNativeWebViteBuildPreset {
    const parsed = readPresetInput(input);
    return Object.freeze({
        tier: 'reactNative',
        bundler: 'vite',
        contributionId: parsed.contributionId,
        platform: 'web',
        sourceEntry: parsed.sourceEntry,
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
 * The real Vite plugin instances an author's `vite.config.ts` MUST spread
 * into `plugins: [...]` alongside `@vitejs/plugin-react` (or equivalent) to
 * make `defineReactNativeWebViteBuildPreset`'s `resolve.alias` +
 * `hostRuntimeExternalSpecifiers` actually resolve at build time. Kept as a
 * function (not baked into the frozen data preset) so the preset itself
 * stays a plain serializable description, matching every other
 * `define*BuildPreset` helper in this file's siblings.
 */
export function createReactNativeWebVitePlugins(): readonly [PluginUiHostRuntimeExternalsVitePlugin] {
    return [createPluginUiHostRuntimeExternalsVitePlugin({
        specifiers: PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
    })];
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
    PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';
