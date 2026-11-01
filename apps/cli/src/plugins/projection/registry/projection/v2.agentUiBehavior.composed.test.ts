import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { describe, expect, it } from 'vitest';
import {
    PluginContributesV2Schema,
    PluginProjectionV2Schema,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './v2';
import type { ResolvedContributionRegistry } from '../types';
import { projectManifestAgentContribution } from '../projectManifestAgentContribution';
import { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } from '../../../../../../ui/sources/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { resolveAgentCatalogProjection } from '../../../../../../ui/sources/agents/backendCatalog/agentCatalogProjection';
import { readCurrentProjectedAgentCapabilities } from '../../../../../../ui/sources/agents/backendCatalog/currentAgentCapabilities';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../sources/generatedBundledPluginManifests';
import { readBundledPluginManifest } from '../builtIn/locators';
import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';

function emptyRegistry(): ResolvedContributionRegistry {
    return createResolvedContributionRegistry({});
}

describe('external Agent UI-behavior descriptor projection', () => {
    it('carries generated MCP control declarations through the daemon and the strict tools list consumer', async () => {
        const agents = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.flatMap(locator => {
            const ingestion = ingestCanonicalPluginManifest(readBundledPluginManifest(locator), {
                manifestAuthority: 'bundled_first_party', sourceProvenance: 'localSource',
            });
            if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
            return (ingestion.manifest.contributes.agents ?? []).map(definition => projectManifestAgentContribution({
                definition, pluginId: locator.pluginId, provenance: 'first_party', source: { kind: 'bundled' },
            }));
        });
        const registry = { ...emptyRegistry(), agents } satisfies ResolvedContributionRegistry;
        const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
        const execute = createMcpServerActionExecuteV1({
            readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
                readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: {
                    v: 1, bindings: [], servers: [{ id: 'server', name: 'server', transport: 'stdio',
                        stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
                } } }) }),
            readToolAgentFacts: async () => ({ agents: Object.keys(projection.agentsById).flatMap(agentId => {
                const current = readCurrentProjectedAgentCapabilities({ projection, agentId });
                return current ? [{ agentId, ...current.capabilities.tools }] : [];
            }) }),
            mutate: async () => { throw new Error('Tools list does not write'); },
            machine: async () => { throw new Error('Tools list does not launch MCP'); },
        });
        const receipt = await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' },
            context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } });
        if (!receipt.ok) throw new Error(receipt.errorCode);
        const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
        expect(listed.perAgent.status).toBe('ready');
        const byId = new Map(listed.perAgent.agents.map(agent => [agent.agentId, agent]));
        expect(byId.get('claude')).toMatchObject({ off: 'hidden', approval: 'host' });
        expect(byId.get('pi')).toMatchObject({ off: 'hidden', approval: 'host' });
        expect(byId.get('kilo')).toMatchObject({ off: 'blocked', approval: 'host' });
        expect(byId.get('codex')).toMatchObject({ off: 'hidden', approval: 'host' });
        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(resolveAgentCatalogProjection('claude', { enabledAgentIds: [],
            mergedProviderProjectionById: adapted.mergedProviderProjectionById }).title).toBe('Claude');
    });
    it('carries registry aliases through the real manifest catalog, daemon wire and client catalog', () => {
        const definition = PluginContributesV2Schema.parse({ agents: [{
            id: 'claude', title: 'Claude', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            catalog: { acpRegistryIds: ['claude-acp'] },
        }] }).agents[0]!;
        const agent = projectManifestAgentContribution({ definition, pluginId: 'happier.agent.claude',
            provenance: 'first_party', source: { kind: 'bundled' } });
        const registry = { ...emptyRegistry(), agents: [agent] } satisfies ResolvedContributionRegistry;
        const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
        expect(projection.agentsById.claude?.acpRegistryIds).toEqual(['claude-acp']);
        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(resolveAgentCatalogProjection('claude', { enabledAgentIds: [],
            mergedProviderProjectionById: adapted.mergedProviderProjectionById }).acpRegistryIds).toEqual(['claude-acp']);
    });
    it('projects manifest identity text equally for bundled and external Agents', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-bundled',
                title: 'Acme Bundled',
                description: 'Bundled through the same public manifest contract.',
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
                    pluginId: 'acme.bundled',
                    localId: definition.id,
                }),
                provenance: 'first_party' as const,
                source: { kind: 'bundled' as const },
                pluginId: 'acme.bundled',
                definition: { kindVersion: 1 as const, id: definition.id, ownedBackendIds: [] },
                richDefinition: { provenance: 'first_party' as const, definition },
            }],
        } satisfies ResolvedContributionRegistry;

        expect(buildPluginProjectionV2({ registry, generation: 20 }).agentsById['acme-bundled'])
            .toMatchObject({
                title: 'Acme Bundled',
                subtitle: 'Bundled through the same public manifest contract.',
            });
    });

    it('qualifies public Connected Account purposes through the Agent package identity', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-account-agent',
                title: 'Acme Account Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                connectedAccounts: [{
                    purpose: 'primary',
                    service: 'account',
                    required: false,
                    credentialKinds: ['token'],
                }],
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
                    pluginId: 'acme.accounts',
                    localId: definition.id,
                }),
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.accounts',
                definition: { kindVersion: 1 as const, id: definition.id, ownedBackendIds: [] },
                richDefinition: { provenance: 'external' as const, definition },
            }],
        } satisfies ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 23 });
        expect(projection.agentsById['acme-account-agent']?.connectedAccounts).toEqual([{
            purpose: 'primary',
            service: { pluginId: 'acme.accounts', localId: 'account' },
            required: false,
            credentialKinds: ['token'],
        }]);
        expect(PluginProjectionV2Schema.parse(projection).agentsById['acme-account-agent']?.connectedAccounts)
            .toEqual(projection.agentsById['acme-account-agent']?.connectedAccounts);
    });

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
                    identityColor: { light: '#112233', dark: '#aabbcc' },
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
                    session: {
                        providerBehavior: {
                            kind: 'session.providerBehavior.v1',
                            participants: {
                                sidechainIds: {
                                    kind: 'toolCallInputString',
                                    toolNames: ['AcmeWorker'],
                                    inputKey: 'workerId',
                                },
                            },
                        },
                        visibleMessages: {
                            kind: 'session.visibleMessages.v1',
                            subagentKinds: ['acme_worker'],
                            fallbackToolNames: ['AcmeWorker'],
                            excludeJsonEventTypes: ['acme_internal'],
                        },
                    },
                },
            }],
        }).agents[0]!;

        expect(definition.ui?.behavior).toBeDefined();
        expect(definition.ui?.session).toBeDefined();

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
                    loadedInHappierSessions: true,
                    metadata: { agentId: 'acme-mcp' },
                },
            }],
        } satisfies ResolvedContributionRegistry;

        expect(buildPluginProjectionV2({ registry, generation: 24 }).agentsById['acme-bystander'])
            .not.toHaveProperty('ui');
    });
});
