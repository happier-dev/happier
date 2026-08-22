import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';

const INSPECTOR_PLUGIN_ID = 'happier.inspector';

describe('bundled Inspector canonical UI graph', () => {
    it('resolves manifest semantics and the generated physical graph without a handwritten UI map', () => {
        const contributions = resolveBuiltInContributions();
        const inspectorRenderer = contributions.uiRenderersV2?.find(
            (entry) => entry.pluginId === INSPECTOR_PLUGIN_ID,
        );
        const inspectorArtifacts = inspectorRenderer?.generatedUiArtifactsManifest?.entries ?? [];

        expect(contributions.settings?.filter((entry) => entry.pluginId === INSPECTOR_PLUGIN_ID)).toEqual([
            expect.objectContaining({
                definition: expect.objectContaining({
                    id: 'settings',
                    target: { kind: 'plugin' },
                    scope: 'daemon',
                }),
            }),
        ]);
        expect(contributions.uiViewsV2?.filter((entry) => entry.pluginId === INSPECTOR_PLUGIN_ID)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                definition: expect.objectContaining({
                    id: 'inspector-app',
                    container: 'rightSidebarTab',
                    target: { kind: 'app' },
                    renderer: 'inspector-renderer',
                }),
            }),
        ]));
        expect(inspectorRenderer).toMatchObject({
            pluginId: INSPECTOR_PLUGIN_ID,
            definition: {
                id: 'inspector-renderer',
                kind: 'reactNative',
                artifact: 'inspector-app-native',
                requiredHostMethods: ['executeAction'],
            },
        });
        // The Inspector ships one bundle per translated locale, so this pins the
        // canonical `en` bundle rather than the locale count (same
        // `arrayContaining` shape the view assertion above uses).
        expect(contributions.uiTranslationsV2?.filter(
            (entry) => entry.pluginId === INSPECTOR_PLUGIN_ID,
        )).toEqual(expect.arrayContaining([
            expect.objectContaining({
                definition: expect.objectContaining({
                    locale: 'en',
                    messages: expect.objectContaining({
                        'plugins.inspector.title': 'Plugin Inspector',
                        'plugins.inspector.settings.showDiagnostics':
                            'Show diagnostics in Plugin Inspector',
                    }),
                }),
            }),
        ]));

        expect(inspectorArtifacts.map((entry) => entry.platform).sort()).toEqual([
            'android',
            'ios',
            'web',
        ]);
        expect(inspectorArtifacts.find((entry) => entry.platform === 'web')).toMatchObject({
            contributionId: 'inspector-app-native',
            tier: 'reactNative',
            builtWith: { bundler: 'vite' },
        });
        expect(inspectorArtifacts.find((entry) => entry.platform === 'web')).not.toHaveProperty('repack');
        expect(inspectorArtifacts.filter((entry) => entry.platform !== 'web')).toEqual([
            expect.objectContaining({
                builtWith: expect.objectContaining({ bundler: 'repack' }),
                repack: {
                    containerName: 'happier_inspector_inspector_app_native',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                },
            }),
            expect.objectContaining({
                builtWith: expect.objectContaining({ bundler: 'repack' }),
                repack: {
                    containerName: 'happier_inspector_inspector_app_native',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                },
            }),
        ]);

        expect(contributions.uiTranslations?.some((entry) => entry.pluginId === INSPECTOR_PLUGIN_ID)).toBe(false);

        const resolverSource = readFileSync(
            new URL('./resolveBuiltInContributions.ts', import.meta.url),
            'utf8',
        );
        expect(resolverSource).not.toMatch(/firstPartyUiContributions|FIRST_PARTY_(?:UI|SURFACE|REACT_NATIVE)/u);
    });
});
