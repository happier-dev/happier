import { describe, expect, it } from 'vitest';

import * as reactNativeBuild from './reactNativeBuild';

const { defineReactNativeBundleBuildArtifact } = reactNativeBuild;
const FILE_DIGEST = `sha256:${'a'.repeat(64)}`;
const artifactFile = (relativePath: string) => ({ relativePath, digest: FILE_DIGEST, byteSize: 1 });

function readReactNativeBuildExport<TExport>(name: string): TExport {
    const value = (reactNativeBuild as Record<string, unknown>)[name];
    expect(typeof value).toBe('function');
    return value as TExport;
}

describe('React Native bundle build SDK helper', () => {
    it('defines Re.Pack plain-JS bundle artifact metadata in the installed artifact layout', () => {
        const entry = defineReactNativeBundleBuildArtifact({
            contributionId: 'native-preview',
            platform: 'ios',
            entry: 'react-native/native-preview/ios.bundle.js',
            files: [
                artifactFile('react-native/native-preview/ios.bundle.js'),
                artifactFile('react-native/native-preview/ios.bundle.js.map'),
            ],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            module: { containerName: 'native_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
            compatibility: {
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
                expoRuntimeVersion: '0.2.0-native',
                hermesVersion: '0.15.0',
            },
        });

        expect(entry).toEqual({
            contributionId: 'native-preview',
            tier: 'reactNative',
            platform: 'ios',
            entry: 'react-native/native-preview/ios.bundle.js',
            files: [
                artifactFile('react-native/native-preview/ios.bundle.js'),
                artifactFile('react-native/native-preview/ios.bundle.js.map'),
            ],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            builtWith: { bundler: 'repack', version: '5.0.0' },
            repack: { containerName: 'native_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
            hostUiApiVersion: '1.0.0',
            compat: {
                react: '19.0.0',
                reactNative: '0.83.4',
                expoRuntime: '0.2.0-native',
                hermes: '0.15.0',
            },
        });
    });

    it('rejects Hermes bytecode artifact paths until bytecode revalidation is designed', () => {
        expect(() => defineReactNativeBundleBuildArtifact({
            contributionId: 'native-preview',
            platform: 'ios',
            entry: 'react-native/native-preview/ios.hbc',
            files: [artifactFile('react-native/native-preview/ios.hbc')],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            module: { containerName: 'native_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
            compatibility: {
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
            },
        })).toThrow(/Hermes bytecode/u);
    });

    it('rejects unsafe React Native artifact manifest paths', () => {
        const baseInput = {
            contributionId: 'native-preview',
            platform: 'ios' as const,
            entry: 'react-native/native-preview/ios.bundle.js',
            files: [artifactFile('react-native/native-preview/ios.bundle.js')],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            module: { containerName: 'native_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
            compatibility: {
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
            },
        };

        expect(() => defineReactNativeBundleBuildArtifact({
            ...baseInput,
            entry: '../ios.bundle.js',
        })).toThrow(/relative path|artifact paths/u);

        expect(() => defineReactNativeBundleBuildArtifact({
            ...baseInput,
            files: [
                artifactFile('react-native/native-preview/ios.bundle.js'),
                artifactFile('react-native\\native-preview\\ios.map'),
            ],
        })).toThrow(/relative path/u);
    });

    it('declares a Re.Pack native build preset as plain JS with host-provided native modules', () => {
        const defineReactNativeRepackBuildPreset = readReactNativeBuildExport<(
            input: {
                contributionId: string;
                platform: 'ios' | 'android';
                sourceEntry: string;
                repackVersion: string;
                hostUiApiVersion: string;
                module: {
                    containerName: string;
                    modulePath: string;
                    exportName: string;
                };
                compatibility: {
                    reactVersion: string;
                    reactNativeVersion: string;
                    expoRuntimeVersion?: string;
                    hermesVersion?: string;
                };
            },
        ) => {
            tier: string;
            bundler: string;
            output: { root: string; entry: string };
            repack: {
                version: string;
                bundleFormat: string;
                hermesBytecode: boolean;
                external: readonly string[];
                sharedSingletons: readonly string[];
                nativeModulePolicy: string;
            };
            module: {
                containerName: string;
                modulePath: string;
                exportName: string;
            };
            runtime: { kind: string; requiredFeatureId: string };
        }>('defineReactNativeRepackBuildPreset');

        const preset = defineReactNativeRepackBuildPreset({
            contributionId: 'native-preview',
            platform: 'ios',
            sourceEntry: 'ui/surface.native.tsx',
            module: {
                containerName: 'native_preview',
                modulePath: './PluginPanel',
                exportName: 'PluginPanel',
            },
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            compatibility: {
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                expoRuntimeVersion: '0.2.0-native',
                hermesVersion: '0.15.0',
            },
        });

        expect(preset).toMatchObject({
            tier: 'reactNative',
            bundler: 'repack',
            output: {
                root: 'dist/happier-plugin-ui/react-native/native-preview',
                entry: 'react-native/native-preview/ios/ios.bundle.js',
            },
            repack: {
                version: '5.0.0',
                bundleFormat: 'plainJavaScript',
                hermesBytecode: false,
                external: [
                    'react',
                    'react/jsx-runtime',
                    'react/jsx-dev-runtime',
                    'react-native',
                    'react-native-reanimated',
                    '@react-navigation/native',
                    '@react-navigation/native-stack',
                    '@happier-dev/plugin-sdk/ui/client',
                ],
                sharedSingletons: [
                    'react',
                    'react/jsx-runtime',
                    'react/jsx-dev-runtime',
                    'react-native',
                    'react-native-reanimated',
                    '@react-navigation/native',
                    '@react-navigation/native-stack',
                ],
                nativeModulePolicy: 'hostProvidedOnly',
            },
            module: {
                containerName: 'native_preview',
                modulePath: './PluginPanel',
                exportName: 'PluginPanel',
            },
            runtime: {
                kind: 'hostGated',
                requiredFeatureId: 'plugins.ui.reactNativeBundles',
            },
        });
    });

    it('generates the exact no-fallback Module Federation shared map for author Re.Pack configs', () => {
        const createReactNativeRepackSharedModules = readReactNativeBuildExport<
            () => Readonly<Record<string, Readonly<{
                singleton: true;
                eager: false;
                import: false;
            }>>>
        >('createReactNativeRepackSharedModules');

        const shared = createReactNativeRepackSharedModules();
        expect(Object.keys(shared)).toEqual([
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-native',
            'react-native-reanimated',
            '@react-navigation/native',
            '@react-navigation/native-stack',
        ]);
        expect(shared['react/jsx-runtime']).toEqual({
            singleton: true,
            eager: false,
            import: false,
        });
        expect(shared['react/jsx-dev-runtime']).toEqual({
            singleton: true,
            eager: false,
            import: false,
        });
        expect(shared['react/compiler-runtime']).toBeUndefined();
        expect(Object.isFrozen(shared)).toBe(true);
    });

    it('rejects Re.Pack preset output names that would publish Hermes bytecode', () => {
        const defineReactNativeRepackBuildPreset = readReactNativeBuildExport<(
            input: {
                contributionId: string;
                platform: 'ios' | 'android';
                sourceEntry: string;
                outputFileName?: string;
                repackVersion: string;
                hostUiApiVersion: string;
                module: {
                    containerName: string;
                    modulePath: string;
                    exportName: string;
                };
                compatibility: {
                    reactVersion: string;
                    reactNativeVersion: string;
                };
            },
        ) => unknown>('defineReactNativeRepackBuildPreset');

        expect(() => defineReactNativeRepackBuildPreset({
            contributionId: 'native-preview',
            platform: 'ios',
            sourceEntry: 'ui/surface.native.tsx',
            outputFileName: 'ios.hbc',
            module: {
                containerName: 'native_preview',
                modulePath: './PluginPanel',
                exportName: 'PluginPanel',
            },
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            compatibility: {
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
            },
        })).toThrow(/Hermes bytecode/u);
    });

    it('rejects non-portable generated output path segments before build I/O', () => {
        const defineReactNativeRepackBuildPreset = readReactNativeBuildExport<(
            input: {
                contributionId: string;
                platform: 'ios' | 'android';
                sourceEntry: string;
                outputFileName?: string;
                repackVersion: string;
                hostUiApiVersion: string;
                module: {
                    containerName: string;
                    modulePath: string;
                    exportName: string;
                };
                compatibility: {
                    reactVersion: string;
                    reactNativeVersion: string;
                };
            },
        ) => unknown>('defineReactNativeRepackBuildPreset');
        const base = {
            contributionId: 'native-preview',
            platform: 'ios' as const,
            sourceEntry: 'ui/surface.native.tsx',
            module: {
                containerName: 'native_preview',
                modulePath: './PluginPanel',
                exportName: 'PluginPanel',
            },
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            compatibility: {
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
            },
        };

        for (const outputFileName of ['aux.js', 'NUL.txt', 'ios.']) {
            expect(() => defineReactNativeRepackBuildPreset({
                ...base,
                outputFileName,
            })).toThrow(/path segment/u);
        }
        expect(() => defineReactNativeRepackBuildPreset({
            ...base,
            contributionId: 'con',
        })).toThrow(/path segment/u);
    });
});
