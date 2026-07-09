import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
        agentRuntimes: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        lifecycleHandlers: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
        uiDescriptorsById: new Map(),
        lifecycleHandlersById: new Map(),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: {},
        agentDefinitionsById: new Map(),
        agentRuntimeDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

const display = {
    title: 'Preview',
    iconToken: 'browser',
    tone: 'info',
} as const;

const target = {
    kind: 'hostedPluginWeb',
    targetId: 'target_1',
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    display,
} as const;

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
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-target',
                        target,
                        display,
                        featureGate: 'browser.viewTargets',
                    },
                },
            ],
            browserActions: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'open-preview',
                        kind: 'openTarget',
                        target,
                        display,
                        policy: {
                            requiredFeatureIds: ['browser.viewTargets'],
                            profileMode: 'session',
                        },
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
            target: { kind: 'hostedPluginWeb', contributionId: 'preview-web' },
            featureGate: 'browser.viewTargets',
        });
        expect(entries['browserAction:acme.preview:open-preview']).toMatchObject({
            id: 'browserAction:acme.preview:open-preview',
            pluginId: 'acme.preview',
            contributionKind: 'browserAction',
            actionKind: 'openTarget',
            policy: {
                requiredFeatureIds: ['browser.viewTargets'],
                profileMode: 'session',
            },
        });
    });
});
