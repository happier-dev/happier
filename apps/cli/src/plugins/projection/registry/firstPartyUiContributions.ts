import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
    INSPECTOR_APP_SURFACE,
    INSPECTOR_NATIVE_BUNDLE_IOS,
    INSPECTOR_NATIVE_BUNDLE_WEB,
    INSPECTOR_NATIVE_IOS_ARTIFACT_DIGEST,
    INSPECTOR_NATIVE_IOS_ASSET_PATH,
    INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_BYTE_SIZE,
    INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_DIGEST,
    INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_PATH,
    INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_BYTE_SIZE,
    INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_DIGEST,
    INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_PATH,
    INSPECTOR_NATIVE_IOS_SOURCE_MAP_BYTE_SIZE,
    INSPECTOR_NATIVE_IOS_SOURCE_MAP_DIGEST,
    INSPECTOR_NATIVE_IOS_SOURCE_MAP_PATH,
    INSPECTOR_NATIVE_WEB_ARTIFACT_BYTE_SIZE,
    INSPECTOR_NATIVE_WEB_ARTIFACT_DIGEST,
    INSPECTOR_NATIVE_WEB_ASSET_PATH,
    INSPECTOR_NATIVE_BUNDLE_ID,
    INSPECTOR_PLUGIN_ID,
    INSPECTOR_PLUGIN_PACKAGE_NAME,
    INSPECTOR_SETTINGS,
    INSPECTOR_UI_TRANSLATIONS,
} from '@happier-dev/plugins-inspector/manifest';

import type {
    ResolvedReactNativeBundleContribution,
    ResolvedSettingsContribution,
    ResolvedStructuredMessageContribution,
    ResolvedSurfacePlacementContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiTranslationsContribution,
} from './types';

/**
 * First-party bundled plugin-UI contributions (FINALIZATION-PLAN Phase 7.1).
 *
 * UI-DOGFOOD replaces the legacy `happier.core` built-in inspector with a real
 * first-party package owner: `@happier-dev/plugins-inspector` / `happier.inspector`.
 * This file is only the CLI projection bridge that lets bundled first-party UI
 * contributions flow through the same resolved registry/projection/static-asset
 * lifecycle as installed plugins.
 *
 * RN-DOGFOOD (LEDGER DEC-6/DEC-7): the inspector's UI moved from `hostedWeb`
 * (a static HTML artifact with no real source ever checked into this repo) to
 * the ONE `reactNative`-mode surface at `src/ui/renderSurface.tsx`.
 *
 * FIX-RNWEB-SERVING (LEDGER DEC-6/DEC-8 follow-up, closing LIVE-MATRIX's
 * Cell-1 structural finding): BOTH platform siblings (`ios`, `web`) are now
 * real, digest-verified, production `installedArtifact` bundles — the SAME
 * `uiArtifacts` byte-serving path NATIVE-PIPELINE wired for ios first now
 * also covers web. A first-party BUNDLED plugin's `pluginSource` correctly
 * classifies as `internal` (`ui/projection.ts#resolveReactNativePluginSource`),
 * which the dev-hot-reload path correctly denies — that gate stays exactly
 * as-is (dev-hot-reload remains a `local_trusted` DEV-plugin affordance
 * only). The fix is a real production artifact on every platform, not a
 * bent dev path.
 */

const FIRST_PARTY_BUNDLED_SOURCE = Object.freeze({ kind: 'bundled' as const });
const INSPECTOR_MANIFEST_DIGEST = `bundled:${INSPECTOR_PLUGIN_PACKAGE_NAME}@0.0.0`;

// NATIVE-PIPELINE: the inspector's ios artifact is a real file on disk
// (`dist/happier-plugin-ui/react-native/inspector-app-native/ios.bundle.js`,
// built by `rspack.config.mjs`), not a synthetic dev-hot-reload declaration —
// unlike `manifestPath` above (a synthetic `bundled:...` string with no
// filesystem meaning), byte-serving (`DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ`)
// needs a REAL `pluginRootPath` to resolve `assetPath` against
// (`resolveContainedPluginResourcePath` in the RPC handler). Resolved once,
// at module load, via the real package's own `package.json` — this package
// is a first-party workspace dependency, so `require.resolve` is safe here
// (this file already runs in the CLI's own Node process).
const INSPECTOR_PLUGIN_ROOT_PATH = dirname(
    createRequire(import.meta.url).resolve(`${INSPECTOR_PLUGIN_PACKAGE_NAME}/package.json`),
);
const APP_PACKAGE_JSON = createRequire(import.meta.url)('@happier-dev/app/package.json') as Readonly<{
    version?: unknown;
}>;
export const FIRST_PARTY_UI_HOST_APP_VERSION = (() => {
    const version = typeof APP_PACKAGE_JSON.version === 'string' ? APP_PACKAGE_JSON.version.trim() : '';
    if (!version) {
        throw new Error('@happier-dev/app/package.json must define a non-empty version for bundled UI artifacts');
    }
    return version;
})();

// FIX-RNWEB-SERVING: a real, previously-uncaught bug (found while wiring the
// web sibling's byte-serving path — never exercised end-to-end before this
// lane, per NATIVE-PIPELINE's own self-attack: "no iOS simulator/device was
// used... never load-tested inside a real RN host app"). `assetPath` values
// on both `reactNativeBundle` uiArtifacts below (`react-native/...`,
// `react-native-web/...`) are the `buildUiArtifacts()` build pipeline's own
// `output.entry` convention (`reactNativeBuild.ts` / `reactNativeWebBuild.ts`),
// which is relative to `dist/happier-plugin-ui/` — NOT relative to
// `INSPECTOR_PLUGIN_ROOT_PATH` (the plugin PACKAGE root). Resolving
// `assetPath` against the package root directly (as the ios entry did until
// this fix) would ask the daemon's `DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ`
// handler to read a path that never existed on disk. Scoping the artifacts'
// `pluginRootPath` to the `dist/happier-plugin-ui/` subdirectory instead
// keeps `assetPath` identical to the real `dist/happier-plugin-ui/ui-artifacts.json`
// manifest's own `entry` field (verifiable byte-for-byte against the real
// build output) and is a STRICTER containment boundary than the package
// root, not a looser one.
const INSPECTOR_UI_ARTIFACTS_ROOT_PATH = join(INSPECTOR_PLUGIN_ROOT_PATH, 'dist', 'happier-plugin-ui');

const INSPECTOR_BUNDLED_SOURCE_SPEC = Object.freeze({
    kind: 'bundled' as const,
    locator: INSPECTOR_PLUGIN_PACKAGE_NAME,
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
    resolvedVersion: '0.0.0',
    resolvedDigest: INSPECTOR_MANIFEST_DIGEST,
});

const BUNDLED_INSPECTOR_METADATA = Object.freeze({
    provenance: 'first_party' as const,
    source: FIRST_PARTY_BUNDLED_SOURCE,
    pluginId: INSPECTOR_PLUGIN_ID,
    manifestPath: `bundled:${INSPECTOR_PLUGIN_ID}`,
    manifestDigest: INSPECTOR_MANIFEST_DIGEST,
    daemonEntryPath: INSPECTOR_PLUGIN_PACKAGE_NAME,
    sourceSpec: INSPECTOR_BUNDLED_SOURCE_SPEC,
});

export const FIRST_PARTY_UI_TRANSLATIONS: readonly ResolvedUiTranslationsContribution[] = Object.freeze([
    {
        ...BUNDLED_INSPECTOR_METADATA,
        definition: INSPECTOR_UI_TRANSLATIONS,
    },
]);

export const FIRST_PARTY_SURFACE_PLACEMENTS: readonly ResolvedSurfacePlacementContribution[] = Object.freeze([
    {
        ...BUNDLED_INSPECTOR_METADATA,
        definition: INSPECTOR_APP_SURFACE,
    },
]);

export const FIRST_PARTY_STRUCTURED_MESSAGES: readonly ResolvedStructuredMessageContribution[] = Object.freeze([]);

export const FIRST_PARTY_REACT_NATIVE_BUNDLES: readonly ResolvedReactNativeBundleContribution[] = Object.freeze([
    {
        ...BUNDLED_INSPECTOR_METADATA,
        definition: INSPECTOR_NATIVE_BUNDLE_WEB,
    },
    {
        ...BUNDLED_INSPECTOR_METADATA,
        definition: INSPECTOR_NATIVE_BUNDLE_IOS,
    },
]);

// NATIVE-PIPELINE: the ios sibling above declares `bundle.assetPath` +
// `bundle.integrity`, so `findReactNativeBundleArtifact`
// (`ui/projection.ts`) needs a matching `uiArtifacts` entry to resolve to
// `state: 'loadable'` — no first-party bundled plugin registered one before
// this (verified by grep: `FIRST_PARTY_UI_ARTIFACTS` did not exist). Real
// byteSize/digest below match the actual built file, computed by the same
// `buildUiArtifacts` pipeline that produced `dist/happier-plugin-ui/ui-artifacts.json`.
//
// FIX-RNWEB-SERVING: `pluginRootPath` is `INSPECTOR_UI_ARTIFACTS_ROOT_PATH`
// (`dist/happier-plugin-ui/`), not the bare package root — see that
// constant's doc comment for the real byte-serving resolution bug this
// fixes for BOTH siblings. The web sibling below is the SECOND real,
// digest-verified artifact this registry entry serves (Vite +
// react-native-web build of the SAME `renderSurface.tsx` source) — closing
// LIVE-MATRIX's Cell-1 structural finding ("no `devUrl` artifact registered
// anywhere... cannot become loadable"): the web sibling now resolves
// through the exact SAME `installedArtifact` production-serving path as
// ios, not a bent dev-hot-reload path.
export const FIRST_PARTY_UI_ARTIFACTS: readonly ResolvedUiArtifactContribution[] = Object.freeze([
    {
        ...BUNDLED_INSPECTOR_METADATA,
        pluginRootPath: INSPECTOR_UI_ARTIFACTS_ROOT_PATH,
        definition: {
            id: `${INSPECTOR_NATIVE_BUNDLE_ID}-ios`,
            contributionId: INSPECTOR_NATIVE_BUNDLE_ID,
            contributionFamily: 'reactNativeBundles',
            artifactKind: 'reactNativeBundle',
            platform: 'ios',
            channel: 'internal',
            integrity: { digest: INSPECTOR_NATIVE_IOS_ARTIFACT_DIGEST },
            compatibility: {
                hostAppVersion: FIRST_PARTY_UI_HOST_APP_VERSION,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                // RN-HARDEN item 2: the artifact's supportedChannels DECLARATION
                // is the channel-gate authority (channel above is provenance
                // metadata only). First-party inspector artifacts may be loaded
                // by internal and development clients.
                supportedChannels: ['internal', 'development'],
                nativeCapabilities: [],
            },
            // RN-HARDEN item 1: rebuilt size after the strict-safe guardedRequire
            // transform (adds the try/catch wrapper's own bytes; was 33512).
            byteSize: 33638,
            contentType: 'application/javascript',
            assetPath: INSPECTOR_NATIVE_IOS_ASSET_PATH,
            files: [
                {
                    relativePath: INSPECTOR_NATIVE_IOS_ASSET_PATH,
                    digest: INSPECTOR_NATIVE_IOS_ARTIFACT_DIGEST,
                    byteSize: 33638,
                },
                {
                    relativePath: INSPECTOR_NATIVE_IOS_SOURCE_MAP_PATH,
                    digest: INSPECTOR_NATIVE_IOS_SOURCE_MAP_DIGEST,
                    byteSize: INSPECTOR_NATIVE_IOS_SOURCE_MAP_BYTE_SIZE,
                },
                {
                    relativePath: INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_PATH,
                    digest: INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_DIGEST,
                    byteSize: INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_BYTE_SIZE,
                },
                {
                    relativePath: INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_PATH,
                    digest: INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_DIGEST,
                    byteSize: INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_BYTE_SIZE,
                },
            ],
        },
    },
    {
        ...BUNDLED_INSPECTOR_METADATA,
        pluginRootPath: INSPECTOR_UI_ARTIFACTS_ROOT_PATH,
        definition: {
            id: `${INSPECTOR_NATIVE_BUNDLE_ID}-web`,
            contributionId: INSPECTOR_NATIVE_BUNDLE_ID,
            contributionFamily: 'reactNativeBundles',
            artifactKind: 'reactNativeBundle',
            platform: 'web',
            channel: 'internal',
            integrity: { digest: INSPECTOR_NATIVE_WEB_ARTIFACT_DIGEST },
            compatibility: {
                hostAppVersion: FIRST_PARTY_UI_HOST_APP_VERSION,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                // RN-HARDEN item 2: the artifact's supportedChannels DECLARATION
                // is the channel-gate authority (channel above is provenance
                // metadata only). First-party inspector artifacts may be loaded
                // by internal and development clients.
                supportedChannels: ['internal', 'development'],
                nativeCapabilities: [],
            },
            byteSize: INSPECTOR_NATIVE_WEB_ARTIFACT_BYTE_SIZE,
            contentType: 'application/javascript',
            assetPath: INSPECTOR_NATIVE_WEB_ASSET_PATH,
        },
    },
]);

export const FIRST_PARTY_SETTINGS: readonly ResolvedSettingsContribution[] = Object.freeze([
    {
        ...BUNDLED_INSPECTOR_METADATA,
        definition: INSPECTOR_SETTINGS,
    },
]);
