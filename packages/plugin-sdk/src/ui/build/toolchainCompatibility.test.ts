import { describe, expect, it } from 'vitest';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';

import {
    PublicToolchainCompatibilityV1Schema,
    createPublicToolchainScaffoldBindingsV1,
    createPublicToolchainCompatibilityV1,
} from './toolchainCompatibility.js';

const candidate = {
    schemaVersion: 1,
    host: { buildIdentity: 'happier-0.2.0' },
    pluginSdk: { version: '0.2.0' },
    pluginUi: { version: '0.2.0', pluginSdkVersion: '0.2.0' },
    framework: {
        react: '19.2.0',
        reactNative: '0.83.4',
        reactNativeWeb: '0.21.2',
        vite: '7.3.1',
        repack: '5.2.5',
        expo: '54.0.0',
        runtime: '0.2.0',
    },
    ui: { artifactGrammarVersion: 1, hostApiVersion: PLUGIN_UI_HOST_API_VERSION_V1 },
    authoringDependencies: {
        nodeTypes: { packageName: '@types/node', dependencySpec: '22.15.3', resolvedVersion: '22.15.3' },
        reactDom: { packageName: 'react-dom', dependencySpec: '19.2.0', resolvedVersion: '19.2.0' },
        reactTypes: { packageName: '@types/react', dependencySpec: '19.2.0', resolvedVersion: '19.2.0' },
        reactNativeCommunityCli: { packageName: '@react-native-community/cli', dependencySpec: '20.1.2', resolvedVersion: '20.1.2' },
        rspack: { packageName: '@rspack/core', dependencySpec: '2.1.3', resolvedVersion: '2.1.3' },
        swcHelpers: { packageName: '@swc/helpers', dependencySpec: '0.5.23', resolvedVersion: '0.5.23' },
        typescript: { packageName: 'typescript', dependencySpec: '5.9.3', resolvedVersion: '5.9.3' },
        typescriptNative: { packageName: '@typescript/native', dependencySpec: 'npm:typescript@7.0.2', resolvedVersion: '7.0.2' },
        viteReactPlugin: { packageName: '@vitejs/plugin-react', dependencySpec: '4.7.0', resolvedVersion: '4.7.0' },
    },
    buildTools: [
        { packageName: 'vite', packageVersion: '7.3.1', executable: 'vite', executableVersion: '7.3.1' },
        { packageName: '@callstack/repack', packageVersion: '5.2.5', executable: 'react-native', executableVersion: '20.1.2' },
    ],
} as const;

describe('public toolchain compatibility SDK export', () => {
    it('reuses the Protocol packet owner and rejects an incoherent candidate', () => {
        expect(createPublicToolchainCompatibilityV1(candidate)).toEqual(candidate);
        expect(PublicToolchainCompatibilityV1Schema.parse(candidate)).toEqual(candidate);
        expect(() => createPublicToolchainCompatibilityV1({
            ...candidate,
            pluginUi: { ...candidate.pluginUi, pluginSdkVersion: '0.1.0' },
        })).toThrow(/plugin SDK/i);
    });

    it('derives every scaffold dependency and compatibility fact from the one packet', () => {
        const bindings = createPublicToolchainScaffoldBindingsV1(candidate);

        expect(bindings).toEqual({
            dependencies: {
                '@happier-dev/plugin-sdk': '0.2.0',
                '@happier-dev/plugin-ui': '0.2.0',
                react: '19.2.0',
                'react-dom': '19.2.0',
                'react-native': '0.83.4',
                'react-native-web': '0.21.2',
            },
            devDependencies: {
                '@callstack/repack': '5.2.5',
                '@react-native-community/cli': '20.1.2',
                '@rspack/core': '2.1.3',
                '@swc/helpers': '0.5.23',
                '@types/node': '22.15.3',
                '@types/react': '19.2.0',
                typescript: '5.9.3',
                '@typescript/native': 'npm:typescript@7.0.2',
                '@vitejs/plugin-react': '4.7.0',
                vite: '7.3.1',
            },
            reactNativeCompatibility: {
                hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
                reactNativeVersion: '0.83.4',
                reactVersion: '19.2.0',
                viteVersion: '7.3.1',
            },
            toolchain: {
                expo: '54.0.0',
                repack: '5.2.5',
                runtime: '0.2.0',
            },
        });
        expect(bindings).not.toHaveProperty('enginesHappier');
        expect(Object.isFrozen(bindings)).toBe(true);
        expect(Object.isFrozen(bindings.dependencies)).toBe(true);
        expect(Object.isFrozen(bindings.devDependencies)).toBe(true);
    });
});
