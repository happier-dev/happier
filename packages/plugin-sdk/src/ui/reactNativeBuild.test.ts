import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import * as reactNativeBuild from './reactNativeBuild';

const requireFromPluginSdk = createRequire(import.meta.url);
type EnhancedResolve = (path: string, request: string, callback: (error: Error | null, result?: string) => void) => void;
type EnhancedResolveModule = Readonly<{
    create: (options: Readonly<Record<string, unknown>>) => EnhancedResolve;
}>;

const enhancedResolve = requireFromPluginSdk('enhanced-resolve') as EnhancedResolveModule;
const repack = requireFromPluginSdk('@callstack/repack') as Readonly<{
    getResolveOptions: (platform: string) => Readonly<Record<string, unknown>>;
}>;

function resolveWithEnhancedResolve(
    resolver: EnhancedResolve,
    path: string,
    request: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        resolver(path, request, (error, result) => {
            if (error) {
                reject(error);
                return;
            }
            if (!result) {
                reject(new Error(`enhanced-resolve returned no path for ${request}`));
                return;
            }
            resolve(result);
        });
    });
}

const { defineReactNativeBundleBuildArtifact } = reactNativeBuild;
const digest = (character: string) => PluginUiArtifactDigestV1Schema.parse(
    `sha256:${character.repeat(64)}`,
);
const FILE_DIGEST = digest('a');
const BUNDLE_DIGEST = digest('b');
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
            entry: 'react-native/native-preview/ios.bundle',
            files: [
                artifactFile('react-native/native-preview/ios.bundle'),
                artifactFile('react-native/native-preview/ios.bundle.map'),
            ],
            digest: BUNDLE_DIGEST,
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
            entry: 'react-native/native-preview/ios.bundle',
            files: [
                artifactFile('react-native/native-preview/ios.bundle'),
                artifactFile('react-native/native-preview/ios.bundle.map'),
            ],
            digest: BUNDLE_DIGEST,
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

    it('derives a native candidate migration module from the same signed Re.Pack module', () => {
        const entry = defineReactNativeBundleBuildArtifact({
            contributionId: 'native-preview',
            platform: 'ios',
            entry: 'react-native/native-preview/ios.bundle',
            files: [artifactFile('react-native/native-preview/ios.bundle')],
            digest: BUNDLE_DIGEST,
            repackVersion: '5.0.0',
            hostUiApiVersion: '1.0.0',
            module: { containerName: 'native_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
            collectionMigrations: { exportName: 'collectionMigrations' },
            compatibility: { reactVersion: '19.0.0', reactNativeVersion: '0.83.4' },
        });

        expect(entry.collectionMigrations).toEqual({
            containerName: 'native_preview',
            modulePath: './renderSurface',
            exportName: 'collectionMigrations',
        });
    });

    it('rejects Hermes bytecode artifact paths until bytecode revalidation is designed', () => {
        expect(() => defineReactNativeBundleBuildArtifact({
            contributionId: 'native-preview',
            platform: 'ios',
            entry: 'react-native/native-preview/ios.hbc',
            files: [artifactFile('react-native/native-preview/ios.hbc')],
            digest: BUNDLE_DIGEST,
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
            entry: 'react-native/native-preview/ios.bundle',
            files: [artifactFile('react-native/native-preview/ios.bundle')],
            digest: BUNDLE_DIGEST,
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
            entry: '../ios.bundle',
        })).toThrow(/relative path|artifact paths/u);

        expect(() => defineReactNativeBundleBuildArtifact({
            ...baseInput,
            files: [
                artifactFile('react-native/native-preview/ios.bundle'),
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
                entry: 'react-native/native-preview/ios/ios.bundle',
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

    it('restores package exports resolution while preserving logical symlink identity', () => {
        const createReactNativeRepackResolveOptions = readReactNativeBuildExport<
            <TOptions extends Readonly<Record<string, unknown>>>(options: TOptions) => Omit<TOptions, 'exportsFields' | 'symlinks'> & Readonly<{
                exportsFields: readonly ['exports'];
                symlinks: false;
            }>
        >('createReactNativeRepackResolveOptions');
        const repackOptions = Object.freeze({
            extensions: Object.freeze(['.native.tsx', '.tsx', '.ts', '.js']),
            mainFields: Object.freeze(['react-native', 'browser', 'main']),
            exportsFields: Object.freeze([]),
            symlinks: true,
        });

        const resolved = createReactNativeRepackResolveOptions(repackOptions);

        expect(resolved).toEqual({
            extensions: ['.native.tsx', '.tsx', '.ts', '.js'],
            mainFields: ['react-native', 'browser', 'main'],
            exportsFields: ['exports'],
            symlinks: false,
        });
        expect(resolved).not.toBe(repackOptions);
        expect(repackOptions.exportsFields).toEqual([]);
        expect(repackOptions.symlinks).toBe(true);
    });

    it('maps NodeNext .js author imports through the real Re.Pack platform resolver', async () => {
        const createReactNativeRepackResolveOptions = readReactNativeBuildExport<
            <TOptions extends Readonly<Record<string, unknown>>>(options: TOptions) => Omit<TOptions, 'exportsFields' | 'symlinks'> & Readonly<{
                exportsFields: readonly ['exports'];
                extensionAlias?: Readonly<Record<string, unknown>>;
            }>
        >('createReactNativeRepackResolveOptions');
        const root = await mkdtemp(join(tmpdir(), 'happier-repack-extension-alias-'));
        try {
            await mkdir(root, { recursive: true });
            await writeFile(join(root, 'module.ts'), 'export const source = "generic-ts";\n');
            await writeFile(join(root, 'module.ios.tsx'), 'export const source = "ios-tsx";\n');
            await writeFile(join(root, 'module.native.tsx'), 'export const source = "native-tsx";\n');

            const resolvedOptions = createReactNativeRepackResolveOptions(
                repack.getResolveOptions('ios'),
            );
            expect(resolvedOptions.extensionAlias?.['.js']).toEqual([
                '.ios.js', '.native.js', '.js',
                '.ios.jsx', '.native.jsx', '.jsx',
                '.ios.ts', '.ios.tsx',
                '.native.ts', '.native.tsx',
                '.ts', '.tsx',
            ]);

            const resolver = enhancedResolve.create(resolvedOptions);
            // Platform/native TypeScript sources outrank a generic `.ts` source even when the
            // author wrote the NodeNext-required `.js` specifier. The resolver
            // retains the logical author path rather than collapsing it through
            // an OS-specific realpath.
            await expect(resolveWithEnhancedResolve(resolver, root, './module.js'))
                .resolves.toBe(join(root, 'module.ios.tsx'));

            // Existing JavaScript sources retain Re.Pack's original first-position priority;
            // TypeScript/TSX entries are fallbacks for NodeNext-authored `.js` imports.
            const javascriptRoot = join(root, 'with-javascript-source');
            await mkdir(javascriptRoot);
            await writeFile(join(javascriptRoot, 'module.ios.js'), 'export const source = "ios-js";\n');
            const resolverWithJavaScriptSource = enhancedResolve.create(resolvedOptions);
            await expect(resolveWithEnhancedResolve(resolverWithJavaScriptSource, javascriptRoot, './module.js'))
                .resolves.toBe(join(javascriptRoot, 'module.ios.js'));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('derives the shared/external closure from the protocol-owned host runtime externals (EU-6)', () => {
        // The literal expectations above are the negative control: they pin
        // WHICH modules are host-provided. This one pins WHERE that decision
        // lives. The build must not re-declare the closure locally — that is
        // how it came to externalize Reanimated and React Navigation with
        // `import:false` against a host share scope that provided neither
        // (UI-D14). Adding a specifier to the protocol list alone must show up
        // here and fail `apps/ui`'s host-provider closure check.
        const createReactNativeRepackSharedModules = readReactNativeBuildExport<
            () => Readonly<Record<string, unknown>>
        >('createReactNativeRepackSharedModules');
        const defineReactNativeRepackBuildPreset = readReactNativeBuildExport<(
            input: Readonly<Record<string, unknown>>,
        ) => { repack: { external: readonly string[]; sharedSingletons: readonly string[] } }>(
            'defineReactNativeRepackBuildPreset',
        );

        expect(Object.keys(createReactNativeRepackSharedModules()))
            .toEqual([...PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS]);

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
            compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.5' },
        });

        expect(preset.repack.sharedSingletons).toEqual([...PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS]);
        // Only the SDK's own client subpath may be external without being a
        // host-provided share-scope singleton: the plugin bundle resolves it
        // through the SDK's own alias, not Module Federation.
        expect(preset.repack.external).toEqual([
            ...PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS,
            '@happier-dev/plugin-sdk/ui/client',
        ]);
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
