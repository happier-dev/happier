import { describe, expect, it } from 'vitest';

import * as hostedWebBuild from './hostedWebBuild.js';

const { defineHostedWebStaticAssets } = hostedWebBuild;

function readHostedWebBuildExport<TExport>(name: string): TExport {
    const value = (hostedWebBuild as Record<string, unknown>)[name];
    expect(typeof value).toBe('function');
    return value as TExport;
}

describe('hosted web build helpers', () => {
    it('binds a hosted-web contribution to the canonical installed static asset runtime mode', () => {
        const binding = defineHostedWebStaticAssets({
            contributionId: 'preview-web',
            artifactId: 'preview-web-static',
            assetRootId: 'hosted-web/preview-web',
        });

        expect(binding).toEqual({
            contributionId: 'preview-web',
            hostedWebServiceRef: {
                kind: 'staticAssets',
                assetRootId: 'hosted-web/preview-web',
            },
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-static',
                assetRootId: 'hosted-web/preview-web',
            },
        });
    });

    it('rejects empty artifact and asset root identifiers before authors publish invalid metadata', () => {
        expect(() => defineHostedWebStaticAssets({
            contributionId: 'preview-web',
            artifactId: ' ',
            assetRootId: 'hosted-web/preview-web',
        })).toThrow();

        expect(() => defineHostedWebStaticAssets({
            contributionId: 'preview-web',
            artifactId: 'preview-web-static',
            assetRootId: ' ',
        })).toThrow();
    });

    it('declares a Vite hosted-web preset with deny-by-default browser security', () => {
        const defineHostedWebViteBuildPreset = readHostedWebBuildExport<(
            input: {
                contributionId: string;
                sourceEntry: string;
                viteVersion: string;
                hostUiApiVersion: string;
                reactVersion: string;
            },
        ) => {
            tier: string;
            bundler: string;
            output: { root: string; entry: string };
            vite: {
                mode: string;
                base: string;
                bundledDependencies: readonly string[];
                external: readonly string[];
            };
            security: {
                allowedNavigationOrigins: readonly string[];
                allowedCallbackOrigins: readonly string[];
                allowedConnectOrigins: readonly string[];
                csp: {
                    connectSrc: string;
                    allowEval: false;
                };
                sourceMaps: string;
                mixedContent: string;
            };
            requiredFeatureIds: readonly string[];
        }>('defineHostedWebViteBuildPreset');

        const preset = defineHostedWebViteBuildPreset({
            contributionId: 'preview-web',
            sourceEntry: 'ui/surface.tsx',
            viteVersion: '7.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
        });

        expect(preset).toMatchObject({
            tier: 'hostedWeb',
            bundler: 'vite',
            output: {
                root: 'dist/happier-plugin-ui/hosted-web/preview-web',
                entry: 'hosted-web/preview-web/index.html',
            },
            vite: {
                mode: 'app',
                base: './',
                bundledDependencies: ['react-native-web'],
                external: [],
            },
            security: {
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [],
                csp: {
                    connectSrc: 'selfOnly',
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'deny',
            },
            requiredFeatureIds: ['plugins.ui.hostedWeb'],
        });
    });

    it('builds hosted-web Vite artifact manifest entries without executing authored UI', () => {
        const defineHostedWebViteBuildArtifact = readHostedWebBuildExport<(
            input: {
                contributionId: string;
                entry: string;
                files: readonly string[];
                digest: string;
                viteVersion: string;
                hostUiApiVersion: string;
                reactVersion: string;
            },
        ) => unknown>('defineHostedWebViteBuildArtifact');

        expect(defineHostedWebViteBuildArtifact({
            contributionId: 'preview-web',
            entry: 'hosted-web/preview-web/index.html',
            files: ['hosted-web/preview-web/index.html', 'hosted-web/preview-web/assets/app.js'],
            digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            viteVersion: '7.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
        })).toEqual({
            contributionId: 'preview-web',
            tier: 'hostedWeb',
            platform: 'web',
            entry: 'hosted-web/preview-web/index.html',
            files: ['hosted-web/preview-web/index.html', 'hosted-web/preview-web/assets/app.js'],
            digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            builtWith: { bundler: 'vite', version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0' },
        });
    });

    it('rejects unsafe hosted-web artifact manifest paths', () => {
        const defineHostedWebViteBuildArtifact = readHostedWebBuildExport<(
            input: {
                contributionId: string;
                entry: string;
                files: readonly string[];
                digest: string;
                viteVersion: string;
                hostUiApiVersion: string;
                reactVersion: string;
            },
        ) => unknown>('defineHostedWebViteBuildArtifact');

        const baseInput = {
            contributionId: 'preview-web',
            entry: 'hosted-web/preview-web/index.html',
            files: ['hosted-web/preview-web/index.html'],
            digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            viteVersion: '7.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
        };

        expect(() => defineHostedWebViteBuildArtifact({
            ...baseInput,
            entry: '../index.html',
        })).toThrow(/relative path|artifact paths/u);

        expect(() => defineHostedWebViteBuildArtifact({
            ...baseInput,
            files: ['hosted-web/preview-web/index.html', 'hosted-web\\preview-web\\assets\\app.js'],
        })).toThrow(/relative path/u);
    });

    it('no longer exports the retired embeddedWeb build preset helpers (LEDGER DEC-6)', () => {
        // RN-WEB-LOADER: embeddedWeb's public authoring surface is retired —
        // its use case (in-process web rendering) is a strict subset of what
        // reactNative-web (`reactNativeWebBuild.ts`) now offers, for identical
        // runtime cost, plus native support. Grep-zero gate: these exports must
        // not exist on the hostedWebBuild module.
        const RETIRED_EXPORTS = [
            'defineEmbeddedWebViteBuildPreset',
            'defineEmbeddedWebViteBuildArtifact',
        ] as const;
        for (const retiredExport of RETIRED_EXPORTS) {
            expect(
                Object.prototype.hasOwnProperty.call(hostedWebBuild, retiredExport),
                `retired embeddedWeb export '${retiredExport}' must be deleted (no thin wrapper)`,
            ).toBe(false);
        }
    });

    it('rejects unsafe generated output path segments', () => {
        const defineHostedWebViteBuildPreset = readHostedWebBuildExport<(
            input: {
                contributionId: string;
                sourceEntry: string;
                viteVersion: string;
                hostUiApiVersion: string;
                reactVersion: string;
            },
        ) => unknown>('defineHostedWebViteBuildPreset');

        expect(() => defineHostedWebViteBuildPreset({
            contributionId: '../preview-web',
            sourceEntry: 'ui/surface.tsx',
            viteVersion: '7.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
        })).toThrow(/path segment/u);
    });

    it('normalizes dot-prefixed relative source entries without allowing traversal', () => {
        const defineHostedWebViteBuildPreset = readHostedWebBuildExport<(
            input: {
                contributionId: string;
                sourceEntry: string;
                viteVersion: string;
                hostUiApiVersion: string;
                reactVersion: string;
            },
        ) => { sourceEntry: string }>('defineHostedWebViteBuildPreset');

        expect(defineHostedWebViteBuildPreset({
            contributionId: 'preview-web',
            sourceEntry: './ui/surface.tsx',
            viteVersion: '7.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
        }).sourceEntry).toBe('ui/surface.tsx');
    });
});
