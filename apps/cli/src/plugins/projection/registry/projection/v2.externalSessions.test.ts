import { describe, expect, it } from 'vitest';

import {
    PluginContributesV2Schema,
    PluginProjectionV2Schema,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '../types';
import { buildPluginProjectionV2 } from './v2';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
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

describe('buildPluginProjectionV2 external sessions', () => {
    it('preserves the closed configured-path override instance in the canonical projection', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-agent',
                title: 'Acme Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    surfaces: ['externalSessions'],
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
                surfaces: {
                    externalSession: {
                        sources: [{
                            sourceKind: 'acmeArchive',
                            schema: {
                                fields: [
                                    { name: 'kind', kind: 'literal', value: 'acmeArchive' },
                                    { name: 'archivePath', kind: 'string', min: 1 },
                                ],
                            },
                            key: { segments: [{ kind: 'literal', value: 'acmeArchive' }] },
                            instances: [
                                { kind: 'default', constants: { archivePath: '/archives/default' } },
                                {
                                    kind: 'agentSettingOverride',
                                    settingId: 'acmeArchivePath',
                                    field: 'archivePath',
                                    normalization: 'configuredPath',
                                    constants: {},
                                },
                            ],
                        }],
                    },
                },
            }],
        }).agents[0]!;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            agents: [{
                id: definition.id,
                identity: createPluginContributionIdentity({
                    pluginId: 'acme.external-sessions',
                    localId: definition.id,
                }),
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.external-sessions',
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

        const projection = buildPluginProjectionV2({ registry, generation: 17 });

        expect(projection.agentsById['acme-agent']?.externalSessions?.sources)
            .toEqual(definition.surfaces?.externalSession?.sources);
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
    });
});
