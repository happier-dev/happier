import { describe, expect, it } from 'vitest';

import * as reactNativeBuild from './reactNativeBuild';

const { defineReactNativeBundleBuildArtifact } = reactNativeBuild;

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
                'react-native/native-preview/ios.bundle.js',
                'react-native/native-preview/ios.bundle.js.map',
            ],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
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
                'react-native/native-preview/ios.bundle.js',
                'react-native/native-preview/ios.bundle.js.map',
            ],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            builtWith: { bundler: 'repack', version: '5.0.0' },
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
            files: ['react-native/native-preview/ios.hbc'],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
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
            files: ['react-native/native-preview/ios.bundle.js'],
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
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
            files: ['react-native/native-preview/ios.bundle.js', 'react-native\\native-preview\\ios.map'],
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
            runtime: { kind: string; requiredFeatureId: string };
        }>('defineReactNativeRepackBuildPreset');

        const preset = defineReactNativeRepackBuildPreset({
            contributionId: 'native-preview',
            platform: 'ios',
            sourceEntry: 'ui/surface.native.tsx',
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
                entry: 'react-native/native-preview/ios.bundle.js',
            },
            repack: {
                version: '5.0.0',
                bundleFormat: 'plainJavaScript',
                hermesBytecode: false,
                external: [
                    'react',
                    'react-native',
                    'react-native-reanimated',
                    '@react-navigation/native',
                    '@react-navigation/native-stack',
                    '@happier-dev/plugin-sdk/ui/hostApiClient',
                ],
                sharedSingletons: [
                    'react',
                    'react-native',
                    'react-native-reanimated',
                    '@react-navigation/native',
                    '@react-navigation/native-stack',
                ],
                nativeModulePolicy: 'hostProvidedOnly',
            },
            runtime: {
                kind: 'hostGated',
                requiredFeatureId: 'plugins.ui.reactNativeBundles',
            },
        });
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
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            compatibility: {
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
            },
        })).toThrow(/Hermes bytecode/u);
    });
});
