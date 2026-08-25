import { describe, expect, it } from 'vitest';
import {
    PluginContributesV2Schema,
    PluginProjectionV2Schema,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './v2';
import type { ResolvedContributionRegistry } from '../types';

function emptyRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
        providers: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        activationTargets: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
        catalogEntriesById: {},
        agentDefinitionsById: new Map(),
        providersByContributionKey: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

describe('external Agent UI-behavior descriptor projection', () => {
    it('carries a declared UI-behavior descriptor from the manifest onto the projection', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-ui',
                title: 'Acme UI',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
                ui: {
                    behavior: {
                        permissions: {
                            footer: {
                                usePermissionUpdates: true,
                                forceReadOnlyAfterStop: false,
                                supportsExecPolicyAmendment: true,
                                stopHandling: 'denyOnly',
                            },
                        },
                        newSession: { transcriptStorageModes: ['persisted', 'direct'] },
                    },
                },
            }],
        }).agents[0]!;

        expect(definition.ui?.behavior).toBeDefined();

        const registry = {
            ...emptyRegistry(),
            agents: [{
                id: definition.id,
                identity: createPluginContributionIdentity({
                    pluginId: 'acme.ui',
                    localId: definition.id,
                }),
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.ui',
                definition: {
                    kindVersion: 1 as const,
                    id: definition.id,
                    ownedBackendIds: [],
                },
                richDefinition: {
                    provenance: 'external' as const,
                    definition,
                },
            }],
        } satisfies ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 21 });

        expect(projection.agentsById['acme-ui']?.ui).toEqual(definition.ui);
        // The wire shape must survive the canonical strict projection schema.
        expect(PluginProjectionV2Schema.parse(projection).agentsById['acme-ui']?.ui)
            .toEqual(definition.ui);
    });

    it('omits the descriptor for an Agent that declares none', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-plain',
                title: 'Acme Plain',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                },
            }],
        }).agents[0]!;

        const registry = {
            ...emptyRegistry(),
            agents: [{
                id: definition.id,
                identity: createPluginContributionIdentity({
                    pluginId: 'acme.plain',
                    localId: definition.id,
                }),
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.plain',
                definition: { kindVersion: 1 as const, id: definition.id, ownedBackendIds: [] },
                richDefinition: { provenance: 'external' as const, definition },
            }],
        } satisfies ResolvedContributionRegistry;

        expect(buildPluginProjectionV2({ registry, generation: 22 }).agentsById['acme-plain'])
            .not.toHaveProperty('ui');
    });

    it('does not offer the scan to an Agent that owns no discovery source', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-bystander',
                title: 'Acme Bystander',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                },
            }],
        }).agents[0]!;

        const registry = {
            ...emptyRegistry(),
            agents: [{
                id: definition.id,
                identity: createPluginContributionIdentity({
                    pluginId: 'acme.bystander',
                    localId: definition.id,
                }),
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.bystander',
                definition: { kindVersion: 1 as const, id: definition.id, ownedBackendIds: [] },
                richDefinition: { provenance: 'external' as const, definition },
            }],
            // Owned by a different Agent, so it must not leak onto this one:
            // ownership is the declaration's metadata.agentId, exactly as the
            // daemon's detection resolves it.
            mcpDiscoverySources: [{
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.mcp',
                definition: {
                    id: 'config',
                    title: 'Acme MCP configuration',
                    metadata: { agentId: 'acme-mcp' },
                },
            }],
        } satisfies ResolvedContributionRegistry;

        expect(buildPluginProjectionV2({ registry, generation: 24 }).agentsById['acme-bystander'])
            .not.toHaveProperty('ui');
    });
});
