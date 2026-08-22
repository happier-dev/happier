import { basename } from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { defineReactNativeRepackBuildPreset } from './reactNativeBuild.js';
import { defineReactNativeWebViteBuildPreset } from './reactNativeWebBuild.js';

/**
 * The host app packages every built Plugin UI artifact through Metro as an
 * opaque asset. Metro re-derives asset-ness from the FILE NAME
 * (`metro-resolver`'s `isAssetFile`) at transform time and again at its
 * `/assets` serve route, so a custom resolver returning `assetFiles` cannot
 * rescue a name Metro reads as source. A name Metro reads as source is
 * transformed and EXECUTED instead of delivered as bytes.
 *
 * The host therefore registers `bundle` and `map` as artifact-only asset
 * extensions (`apps/ui/metro.config.js`; pinned there by
 * `apps/ui/sources/__tests__/config/metro.reactNativeWebShim.test.ts`).
 * Source extensions such as `js`/`mjs` can never join that set — they are the
 * app's own module extensions — so the artifact NAMES this SDK declares are
 * the only place the contract can be satisfied.
 */
const HOST_ARTIFACT_ONLY_ASSET_EXTS = ['bundle', 'map'] as const;

const require_ = createRequire(import.meta.url);
const isAssetFileModule = require_('metro-resolver/private/utils/isAssetFile') as
    | ((filePath: string, assetExts: ReadonlySet<string>) => boolean)
    | { default: (filePath: string, assetExts: ReadonlySet<string>) => boolean };
const isAssetFile = typeof isAssetFileModule === 'function'
    ? isAssetFileModule
    : isAssetFileModule.default;

const hostAssetExts = new Set<string>(HOST_ARTIFACT_ONLY_ASSET_EXTS);

function webPresetEntry(): string {
    return defineReactNativeWebViteBuildPreset({
        contributionId: 'native-preview',
        sourceEntry: 'ui/surface.tsx',
        viteVersion: '7.3.1',
        hostUiApiVersion: '1.0.0',
        compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
    }).output.entry;
}

function nativePresetEntry(): string {
    return defineReactNativeRepackBuildPreset({
        contributionId: 'native-preview',
        platform: 'ios',
        sourceEntry: 'ui/renderSurface.tsx',
        repackVersion: '5.0.0',
        hostUiApiVersion: '1.0.0',
        module: {
            containerName: 'native_preview',
            modulePath: './renderSurface',
            exportName: 'renderSurface',
        },
        compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
    }).output.entry;
}

describe('Plugin UI artifact names are Metro-asset-classified', () => {
    it('classifies the react-native-web Vite entry as a packaged asset, not an executable module', () => {
        const entry = webPresetEntry();

        expect(isAssetFile(entry, hostAssetExts)).toBe(true);
        // Locks the reason, not just the string: the pre-fix name is the one
        // Metro executed at the generated inventory's module scope.
        expect(isAssetFile('react-native-web/native-preview/entry.mjs', hostAssetExts)).toBe(false);
        expect(basename(entry)).toBe('entry.mjs.bundle');
    });

    it('classifies the react-native Re.Pack container entry as a packaged asset, not an executable module', () => {
        const entry = nativePresetEntry();

        expect(isAssetFile(entry, hostAssetExts)).toBe(true);
        // `isAssetFile` tests EVERY dot-suffix of the basename, so a trailing
        // `.js` is unreachable as an asset while `js`/`bundle.js` stay out of
        // `assetExts` — and they must, because `*.bundle.js` is a real
        // importable module name in watched trees (`ajv.bundle.js`).
        expect(isAssetFile('react-native/native-preview/ios/ios.bundle.js', hostAssetExts)).toBe(false);
        expect(basename(entry)).toBe('ios.bundle');
    });

    it('keeps every declared artifact entry terminated by an artifact-only extension', () => {
        for (const entry of [webPresetEntry(), nativePresetEntry()]) {
            const terminalExtension = basename(entry).split('.').pop();
            expect(HOST_ARTIFACT_ONLY_ASSET_EXTS).toContain(terminalExtension);
        }
    });
});
