import { describe, expect, it } from 'vitest';

import {
    createReactNativeWebVitePlugins,
    defineReactNativeWebViteBuildArtifact,
    defineReactNativeWebViteBuildPreset,
} from './reactNativeWebBuild.js';

describe('React Native web (react-native-web federation) build SDK helper', () => {
    it('declares a Vite preset that aliases react-native to react-native-web and never leaves rollup externals unresolved', () => {
        const preset = defineReactNativeWebViteBuildPreset({
            contributionId: 'native-preview',
            sourceEntry: 'ui/surface.tsx',
            viteVersion: '7.3.1',
            hostUiApiVersion: '1.0.0',
            compatibility: {
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
            },
        });

        expect(preset).toEqual({
            tier: 'reactNative',
            bundler: 'vite',
            contributionId: 'native-preview',
            platform: 'web',
            sourceEntry: 'ui/surface.tsx',
            output: {
                root: 'dist/happier-plugin-ui/react-native-web/native-preview',
                entry: 'react-native-web/native-preview/entry.mjs',
            },
            vite: {
                version: '7.3.1',
                mode: 'library',
                format: 'es',
                base: './',
                resolve: { alias: [{ find: 'react-native', replacement: 'react-native-web' }] },
                hostRuntimeExternalSpecifiers: [
                    'react',
                    'react/jsx-runtime',
                    'react/jsx-dev-runtime',
                    'react-native-web',
                    '@happier-dev/plugin-sdk/ui/client',
                ],
                external: [],
                sourcemap: false,
            },
            compatibility: {
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
            },
            requiredFeatureIds: ['plugins.ui.reactNativeBundles'],
            runtime: {
                kind: 'hostGated',
                requiredFeatureId: 'plugins.ui.reactNativeBundles',
            },
        });
        expect(Object.isFrozen(preset)).toBe(true);
        expect(Object.isFrozen(preset.vite)).toBe(true);
    });

    it('rejects non-portable contribution ids and unsafe source-entry paths before build I/O', () => {
        for (const contributionId of ['../escape', 'con', 'NUL.txt', 'native-preview.']) {
            expect(() => defineReactNativeWebViteBuildPreset({
                contributionId,
                sourceEntry: 'ui/surface.tsx',
                viteVersion: '7.3.1',
                hostUiApiVersion: '1.0.0',
                compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
            })).toThrow(/safe output path segment/u);
        }

        expect(() => defineReactNativeWebViteBuildPreset({
            contributionId: 'native-preview',
            sourceEntry: '../ui/surface.tsx',
            viteVersion: '7.3.1',
            hostUiApiVersion: '1.0.0',
            compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
        })).toThrow(/relative path/u);
    });

    it('exposes the real host-runtime-externals Vite plugin instance authors must include', () => {
        const plugins = createReactNativeWebVitePlugins();

        expect(plugins).toHaveLength(1);
        expect(plugins[0]).toMatchObject({ name: 'happier-plugin-ui-host-runtime-externals', enforce: 'pre' });
        expect(plugins[0].resolveId('react')).not.toBeNull();
        expect(plugins[0].resolveId('react/jsx-runtime')).not.toBeNull();
        expect(plugins[0].resolveId('react/jsx-dev-runtime')).not.toBeNull();
        expect(plugins[0].resolveId('react-native-web')).not.toBeNull();
        expect(plugins[0].resolveId('@happier-dev/plugin-sdk/ui/client')).not.toBeNull();
        expect(plugins[0].resolveId('react/compiler-runtime')).toBeNull();
    });

    it('defines a reactNative/web manifest artifact entry built with Vite', () => {
        const entry = defineReactNativeWebViteBuildArtifact({
            contributionId: 'native-preview',
            entry: 'react-native-web/native-preview/entry.mjs',
            files: [{
                relativePath: 'react-native-web/native-preview/entry.mjs',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'f'.repeat(64)}`,
            viteVersion: '7.3.1',
            hostUiApiVersion: '1.0.0',
            compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
        });

        expect(entry).toEqual({
            contributionId: 'native-preview',
            tier: 'reactNative',
            platform: 'web',
            entry: 'react-native-web/native-preview/entry.mjs',
            files: [{
                relativePath: 'react-native-web/native-preview/entry.mjs',
                digest: `sha256:${'a'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'f'.repeat(64)}`,
            builtWith: { bundler: 'vite', version: '7.3.1' },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        });
    });
});
