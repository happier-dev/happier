import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
                actions: [],
        tools: [],
        commands: [],
        resources: [],
        promptAssets: [],
        activationTargets: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
                catalogEntriesById: {},
        agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: {},
    };
}

describe('plugin browser projection family', () => {
    it('projects plugin-owned browser targets and actions through a host-owned family', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            browserTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-target',
                        title: { key: 'browser.preview.title', fallback: 'Preview' },
                        description: { key: 'browser.preview.description', fallback: 'Preview environment' },
                        url: 'https://preview.example.test/',
                        launch: 'currentView',
                        profile: 'session',
                    },
                },
            ],
            browserActions: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'open-preview',
                        title: { key: 'browser.preview.open', fallback: 'Open preview' },
                        description: { key: 'browser.preview.openDescription', fallback: 'Open the preview' },
                        action: 'open-preview',
                        target: 'preview-target',
                        placement: 'toolbar',
                        icon: 'open-outline',
                        order: 10,
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 9 });
        const entries = projection.familiesById.pluginBrowser?.entriesById ?? {};

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
        expect(entries['browserAction:acme.preview:open-preview']).toMatchObject({
            id: 'browserAction:acme.preview:open-preview',
            pluginId: 'acme.preview',
            contributionKind: 'browserAction',
            contributionId: 'open-preview',
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
    });
});
