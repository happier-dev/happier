import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '../../browser/index.js';
import * as publicBuildApi from './index.js';
import type {
    PluginUiArtifactPlatform as DirectPluginUiArtifactPlatform,
    PluginUiBuildConfig as DirectPluginUiBuildConfig,
    PluginUiBuildTarget as DirectPluginUiBuildTarget,
} from './config.js';
import type {
    PluginUiArtifactPlatform,
    PluginUiBuildConfig,
    PluginUiBuildTarget,
} from './index.js';

describe('public plugin UI build contract', () => {
    it('owns every supported plugin UI build helper', () => {
        expect(Object.keys(publicBuildApi).sort()).toEqual([
            'BUILD_CONFIG_BASENAMES',
            'PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1',
            'PublicToolchainCompatibilityV1Schema',
            'assertSinglePluginUiPackageInstance',
            'buildUiSurfaceTargets',
            'createPluginUiPackageInstanceRepackPlugin',
            'createPluginUiPackageInstanceVitePlugin',
            'createReactNativeRepackResolveOptions',
            'createReactNativeRepackSharedModules',
            'createReactNativeWebVitePlugins',
            'createPublicToolchainCompatibilityV1',
            'createPublicToolchainScaffoldBindingsV1',
            'defineBuildConfig',
            'defineReactNativeWebViteBuildPreset',
            'resolvePluginUiSurfaceOutDir',
        ].sort());
    });

    it('keeps the browser-safe packet out of the build barrel while deriving the scaffold projection from it', () => {
        expect(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1).toMatchObject({
            schemaVersion: 1,
            framework: {
                reactNative: '0.83.5',
                vite: '7.3.1',
                repack: '5.2.5',
            },
        });
        expect(publicBuildApi.PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1).toEqual(
            publicBuildApi.createPublicToolchainScaffoldBindingsV1(
                PUBLIC_TOOLCHAIN_COMPATIBILITY_V1,
            ),
        );
        expect(publicBuildApi).not.toHaveProperty('PUBLIC_TOOLCHAIN_COMPATIBILITY_V1');
        expect(Object.isFrozen(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1)).toBe(true);
        expect(Object.isFrozen(publicBuildApi.PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1)).toBe(true);
    });

    it('projects every surface emission layout the builder itself re-roots to', () => {
        // Authors emit `build.outDir` through this projection instead of
        // restating the layout `happier-plugin-build-ui` re-roots each surface
        // to. One owner covers every tier, so no arm can drift on its own.
        expect(publicBuildApi.resolvePluginUiSurfaceOutDir({ kind: 'hostedWeb', rendererId: 'main-web' }))
            .toBe('dist/ui/hosted-web/main-web');
        expect(publicBuildApi.resolvePluginUiSurfaceOutDir({
            kind: 'hostedWeb',
            rendererId: 'panel',
            outDir: 'build/work',
        })).toBe('build/work/hosted-web/panel');
        expect(publicBuildApi.resolvePluginUiSurfaceOutDir({
            kind: 'reactNative',
            rendererId: 'main-native',
            platform: 'web',
        })).toBe('dist/ui/react-native-web/main-native');
        expect(publicBuildApi.resolvePluginUiSurfaceOutDir({
            kind: 'reactNative',
            rendererId: 'main-native',
            platform: 'desktop',
            outDir: 'build/work',
        })).toBe('build/work/react-native-web/main-native');
        expect(publicBuildApi.resolvePluginUiSurfaceOutDir({
            kind: 'reactNative',
            rendererId: 'main-native',
            platform: 'ios',
        })).toBe('dist/ui/react-native/main-native/ios');
        expect(publicBuildApi.resolvePluginUiSurfaceOutDir({
            kind: 'reactNative',
            rendererId: 'main-native',
            platform: 'android',
            outDir: 'build/work',
        })).toBe('build/work/react-native/main-native/android');
    });

    it('keeps author build inputs on the curated preview subpath', () => {
        const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

        for (const typeName of [
            'PluginUiArtifactPlatform',
            'PluginUiBuildConfig',
            'PluginUiBuildTarget',
        ]) {
            expect(source).toContain(`export type { ${typeName} } from './config.js';`);
        }
        expect(source).not.toContain('ExactPluginUiBuildTarget');
        expect(source).toContain(
            '/** @preview */\nexport { createReactNativeRepackResolveOptions } from \'../reactNativeBuild.js\';',
        );
        expect(source).toContain(
            '/** @preview */\nexport { buildUiSurfaceTargets } from \'../surface.js\';',
        );
        expect(source).toMatch(
            /\/\*\* @preview \*\/\s*export \{\s*PublicToolchainCompatibilityV1Schema\s*\} from '\.\/toolchainCompatibility\.js';/u,
        );
        expect(source).not.toContain('PUBLIC_TOOLCHAIN_COMPATIBILITY_V1');
        expectTypeOf<PluginUiArtifactPlatform>()
            .toEqualTypeOf<DirectPluginUiArtifactPlatform>();
        expectTypeOf<PluginUiBuildConfig>()
            .toEqualTypeOf<DirectPluginUiBuildConfig>();
        expectTypeOf<PluginUiBuildTarget>()
            .toEqualTypeOf<DirectPluginUiBuildTarget>();
    });
});
