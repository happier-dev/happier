import { describe, expect, it } from 'vitest';
import { normalizePluginBrowserProjection } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

describe('plugin browser projection family', () => {
    it('projects admitted plugin-owned browser targets and actions through a host-owned family', async () => {
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{
                manifest: createPluginManifestV2Fixture({
                    id: 'acme.preview',
                    contributes: {
                        actions: [{
                            id: 'open-preview', title: 'Open preview', scopes: ['session'],
                            surfaces: ['ui'], placementBindings: ['primary'], dangerLevel: 'safe',
                            execution: { target: 'daemon' },
                            inputSchema: { type: 'object' }, resultSchema: { type: 'object' },
                        }],
                        browserTargets: [{
                            id: 'preview-target',
                            title: { key: 'browser.preview.title', fallback: 'Preview' },
                            description: { key: 'browser.preview.description', fallback: 'Preview environment' },
                            url: 'https://preview.example.test/',
                            launch: 'currentView',
                            profile: 'session',
                        }],
                        browserActions: [{
                            id: 'preview-control',
                            title: { key: 'browser.preview.open', fallback: 'Open preview' },
                            description: { key: 'browser.preview.openDescription', fallback: 'Open the preview' },
                            action: 'open-preview',
                            target: 'preview-target',
                            placement: 'toolbar',
                            icon: 'open-outline',
                            order: 10,
                        }],
                    },
                }),
                files: { 'daemon.mjs': "export function activate(api) { api.actions.register('open-preview', async () => ({})); }" },
            }],
        });
        try {
            const projection = buildPluginProjectionV2({ registry: fixture.registry.contributes, generation: fixture.controller.getState().generation });
            const entries = projection.familiesById.pluginBrowser?.entriesById ?? {};
            const browser = normalizePluginBrowserProjection(projection);
            expect(Object.keys(browser.targetsById)).toEqual(['browserTarget:acme.preview:preview-target']);
            expect(browser.actionsById['browserAction:acme.preview:preview-control']?.actionIdentity)
                .toEqual({ pluginId: 'acme.preview', localId: 'open-preview' });
            expect(browser.unknownEntriesById).toEqual({});

            expect(entries['browserTarget:acme.preview:preview-target']).toMatchObject({
                id: 'browserTarget:acme.preview:preview-target',
                pluginId: 'acme.preview',
                contributionKind: 'browserTarget',
                contributionId: 'preview-target',
                target: {
                    kind: 'externalUrl',
                    targetId: 'browserTarget:acme.preview:preview-target',
                    url: 'https://preview.example.test/',
                },
                display: {
                    title: { key: 'browser.preview.title', fallback: 'Preview' },
                    addressLabel: 'https://preview.example.test/',
                },
                description: { key: 'browser.preview.description', fallback: 'Preview environment' },
                currentUrl: 'https://preview.example.test/',
                launchMode: 'currentView',
                profileMode: 'session',
            });
            expect(entries['browserAction:acme.preview:preview-control']).toMatchObject({
                id: 'browserAction:acme.preview:preview-control',
                pluginId: 'acme.preview',
                contributionKind: 'browserAction',
                contributionId: 'preview-control',
                qualifiedActionId: 'acme.preview/open-preview',
                targetId: 'browserTarget:acme.preview:preview-target',
                placement: 'toolbar',
                display: {
                    title: { key: 'browser.preview.open', fallback: 'Open preview' },
                    iconToken: 'open-outline',
                },
                description: { key: 'browser.preview.openDescription', fallback: 'Open the preview' },
                order: 10,
            });
        } finally {
            await fixture.dispose();
        }
    });
});
