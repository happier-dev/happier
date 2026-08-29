import { describe, expect, it, vi } from 'vitest';

const createBootstrapAuthorizationMock = vi.hoisted(() => vi.fn(
    async (input: Readonly<{ descriptor: unknown }>) => ({
        authorization: {
            descriptor: input.descriptor,
            bootstrapFilePath: '/tmp/runner-agent-bootstrap',
            authorityFilePath: '/tmp/runner-agent-authority',
        },
        childEnv: {
            HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE:
                '/tmp/runner-agent-bootstrap',
            HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE:
                '/tmp/runner-agent-authority',
        },
        cleanupBootstrapFile: async () => undefined,
    }),
));

vi.mock('../agentRuntime/sessionBridgeAuthorization', () => ({
    createRunnerAgentSessionBootstrapAuthorization:
        createBootstrapAuthorizationMock,
}));

import {
    prepareRunnerAgentSessionBootstrapForLease,
} from './prepareAgentRuntimeSessionBridge';

describe('prepareRunnerAgentSessionBootstrapForLease', () => {
    it('fails before spawn when the selected backend is absent from the admitted registry', async () => {
        const activateContributionsOnDemand = vi.fn(async () => []);

        await expect(prepareRunnerAgentSessionBootstrapForLease({
            target: {
                kind: 'backend',
                sourceKind: 'built_in',
                backendId: 'pi',
            },
            lease: {
                registry: {
                    contributes: {
                        agentDefinitionsById: new Map(),
                        voiceProviders: [],
                    },
                    agentRuntimesByAgentId: new Map(),
                    runtimeCapabilitiesByPluginId: new Map(),
                    activateContributionsOnDemand,
                },
            },
        } as never)).rejects.toThrow(
            "Runner Agent backend 'pi' is unavailable in the admitted plugin registry",
        );
        expect(activateContributionsOnDemand).not.toHaveBeenCalled();
        expect(createBootstrapAuthorizationMock).not.toHaveBeenCalled();
    });

    it('leaves the existing host-owned configured ACP backend outside plugin runtime admission', async () => {
        const activateContributionsOnDemand = vi.fn(async () => []);

        await expect(prepareRunnerAgentSessionBootstrapForLease({
            target: {
                kind: 'backend',
                sourceKind: 'configured',
                backendId: 'acp-catalog',
            },
            lease: {
                registry: {
                    contributes: {
                        agentDefinitionsById: new Map(),
                        voiceProviders: [],
                    },
                    agentRuntimesByAgentId: new Map(),
                    runtimeCapabilitiesByPluginId: new Map(),
                    activateContributionsOnDemand,
                },
            },
        } as never)).resolves.toBeNull();
        expect(activateContributionsOnDemand).not.toHaveBeenCalled();
        expect(createBootstrapAuthorizationMock).not.toHaveBeenCalled();
    });

    it('fails before spawn when activation does not publish the selected Agent runtime', async () => {
        const pluginId = 'happier.agent.pi';
        const agent = {
            id: 'pi',
            identity: {
                pluginId,
                localId: 'pi',
            },
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'pi',
                ownedBackendIds: ['pi'],
            },
            richDefinition: {
                provenance: 'first_party',
                definition: {
                    id: 'pi',
                    title: {
                        key: 'agents.pi.title',
                        fallback: 'Pi',
                    },
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                },
            },
            pluginId,
        };
        const activateContributionsOnDemand = vi.fn(async () => [{
            pluginId,
            diagnostics: [],
        }]);

        await expect(prepareRunnerAgentSessionBootstrapForLease({
            target: {
                kind: 'backend',
                sourceKind: 'built_in',
                backendId: 'pi',
            },
            lease: {
                registry: {
                    contributes: {
                        agentDefinitionsById: new Map([['pi', agent]]),
                        voiceProviders: [],
                    },
                    agentRuntimesByAgentId: new Map(),
                    runtimeCapabilitiesByPluginId:
                        new Map([[pluginId, new Set()]]),
                    activateContributionsOnDemand,
                },
            },
        } as never)).rejects.toThrow(
            "Runner Agent runtime 'happier.agent.pi/pi' was not published by activation",
        );
        expect(activateContributionsOnDemand).toHaveBeenCalledWith([{
            pluginId,
            family: 'agents',
            localId: 'pi',
        }]);
        expect(createBootstrapAuthorizationMock).not.toHaveBeenCalled();
    });

    it('keeps the plugin-local Agent id separate from its catalog backend id', async () => {
        const pluginId = 'happier.agent.ohmypi';
        const agent = {
            id: 'ohMyPi',
            identity: {
                pluginId,
                localId: 'ohmypi',
            },
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'ohMyPi',
                ownedBackendIds: ['ohMyPi'],
            },
            richDefinition: {
                provenance: 'first_party',
                definition: {
                    id: 'ohMyPi',
                    title: {
                        key: 'agents.ohMyPi.title',
                        fallback: 'Oh My Pi',
                    },
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                },
            },
            pluginId,
        };
        const registry = {
            contributes: {
                agentDefinitionsById: new Map([['ohMyPi', agent]]),
                voiceProviders: [],
            },
            agentRuntimesByAgentId: new Map([['ohMyPi', {
                pluginId,
                pluginVersion: '1.0.0',
                agentId: 'ohMyPi',
                generation: 'activation-generation-1',
                immutableGenerationId: 'immutable-generation-1',
                hasPrimaryRuntime: true,
            }]]),
            runtimeCapabilitiesByPluginId:
                new Map([[pluginId, new Set()]]),
            activateContributionsOnDemand: async () => [],
        };

        const prepared = await prepareRunnerAgentSessionBootstrapForLease({
            target: {
                kind: 'backend',
                sourceKind: 'built_in',
                backendId: 'ohMyPi',
            },
            lease: { registry },
        } as never);

        expect(prepared?.authorization.descriptor).toMatchObject({
            pluginId,
            agentId: 'ohMyPi',
            backendId: 'ohMyPi',
            agentDeclaration: {
                definition: {
                    id: 'ohmypi',
                },
            },
        });
    });

    it('preserves two installed same-local-id Agents as distinct qualified daemon descriptors', async () => {
        const localAgentId = 'assistant';
        const entries = [
            { pluginId: 'acme.alpha', routingId: 'acme.alpha/assistant' },
            { pluginId: 'acme.beta', routingId: 'acme.beta/assistant' },
        ] as const;
        const agentDefinitionsById = new Map(entries.map((entry) => [
            entry.routingId,
            {
                id: entry.routingId,
                identity: {
                    pluginId: entry.pluginId,
                    localId: localAgentId,
                },
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                definition: {
                    kindVersion: 1,
                    id: entry.routingId,
                    ownedBackendIds: [entry.routingId],
                },
                richDefinition: {
                    provenance: 'external' as const,
                    definition: {
                        id: localAgentId,
                        title: `${entry.pluginId} Assistant`,
                        runtime: { kind: 'custom' as const },
                        primary: 'sessions' as const,
                        capabilities: {
                            sessions: {
                                open: ['create' as const],
                                delivery: ['newTurn' as const],
                                cancel: true,
                            },
                        },
                    },
                },
                pluginId: entry.pluginId,
            },
        ]));
        const agentRuntimesByAgentId = new Map(entries.map((entry) => [
            entry.routingId,
            {
                pluginId: entry.pluginId,
                pluginVersion: '1.0.0',
                agentId: entry.routingId,
                localAgentId,
                generation: `generation-${entry.pluginId}`,
                immutableGenerationId: `immutable-${entry.pluginId}`,
                hasPrimaryRuntime: true,
            },
        ]));
        const registry = {
            contributes: {
                agentDefinitionsById,
                voiceProviders: [],
            },
            agentRuntimesByAgentId,
            runtimeCapabilitiesByPluginId: new Map(entries.map((entry) => [
                entry.pluginId,
                new Set(['agents']),
            ])),
            activateContributionsOnDemand: async () => [],
        };

        const prepared = await Promise.all(entries.map((entry) =>
            prepareRunnerAgentSessionBootstrapForLease({
                target: {
                    kind: 'backend',
                    sourceKind: 'built_in',
                    backendId: entry.routingId,
                },
                lease: { registry },
            } as never),
        ));

        // The daemon descriptor carries the exact contribution identity. The
        // registry keeps the shorter host routing id only for lookup, while the
        // contributor factory continues to receive the manifest-local id.
        expect(prepared.map((entry) => entry?.authorization.descriptor.agentId)).toEqual([
            'acme.alpha/agents/assistant',
            'acme.beta/agents/assistant',
        ]);
        expect(prepared.map((entry) => entry?.authorization.descriptor.agentDeclaration?.definition.id))
            .toEqual([localAgentId, localAgentId]);
    });

    it('carries the activated manifest authority without transferring the registry lease', async () => {
        const agent = {
            id: 'claude',
            identity: {
                pluginId: 'happier.agent.claude',
                localId: 'claude',
            },
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'claude',
                ownedBackendIds: ['claude'],
            },
            richDefinition: {
                provenance: 'first_party',
                definition: {
                    id: 'claude',
                    title: { key: 'agents.claude.title', fallback: 'Claude' },
                    description: {
                        key: 'agents.claude.description',
                        fallback: 'Claude',
                    },
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        surfaces: ['terminal'],
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                },
            },
            pluginId: 'happier.agent.claude',
        };
        const registry = {
            contributes: {
                agentDefinitionsById: new Map([['claude', agent]]),
                voiceProviders: [{
                    pluginId: 'happier.voice.claude-realtime',
                    identity: {
                        pluginId: 'happier.voice.claude-realtime',
                        localId: 'conversation',
                    },
                    definition: {
                        id: 'conversation',
                        title: 'Claude realtime',
                        kind: 'conversation',
                        roles: ['realtime_conversation'],
                        platforms: ['web'],
                        capabilities: {
                            readiness: { requirements: [] },
                            turn: { cancelResponse: false, bargeIn: false },
                        },
                        execution: {
                            kind: 'experimental_agent_session_realtime',
                            agent: {
                                pluginId: 'happier.agent.claude',
                                localId: 'claude',
                            },
                        },
                        settings: {
                            schemaVersion: 2,
                            fields: [],
                            connectedServicesBinding: {
                                id: 'globalConnectedServices',
                                title: 'Agent account',
                                agent: {
                                    pluginId: 'happier.agent.claude',
                                    localId: 'claude',
                                },
                                serviceIds: ['anthropic'],
                            },
                        },
                        client: {
                            artifactId: 'claude-realtime',
                            modulePath: './voice',
                            exportName: 'activate',
                        },
                    },
                }],
            },
            agentRuntimesByAgentId: new Map([['claude', {
                pluginId: 'happier.agent.claude',
                pluginVersion: '1.0.0',
                agentId: 'claude',
                generation: 'activation-generation-1',
                immutableGenerationId: 'immutable-generation-1',
                hasPrimaryRuntime: true,
            }]]),
            runtimeCapabilitiesByPluginId: new Map([[
                'happier.agent.claude',
                new Set(['sessionHooks', 'agents']),
            ]]),
            activateContributionsOnDemand: async () => [],
            resolveVoiceProviderRuntimeLifecycle: vi.fn(() => ({
                generation: 'provider-generation-9',
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
            })),
        };

        const prepared = await prepareRunnerAgentSessionBootstrapForLease({
            target: {
                kind: 'backend',
                sourceKind: 'built_in',
                backendId: 'claude',
            },
            lease: { registry },
        } as never);

        expect(prepared?.authorization.descriptor).toEqual(expect.objectContaining({
            pluginId: 'happier.agent.claude',
            agentId: 'claude',
            generation: 'activation-generation-1',
            immutableGenerationId: 'immutable-generation-1',
            agentDeclaration: {
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: agent.richDefinition.definition,
            },
            runtimeAuthority: {
                runtimeCapabilities: ['agents', 'sessionHooks'],
            },
        }));
        expect(prepared?.authorization.descriptor).not.toHaveProperty('registry');
        expect(prepared?.authorization.descriptor).not.toHaveProperty('lease');
        expect(registry.resolveVoiceProviderRuntimeLifecycle)
            .not.toHaveBeenCalled();
    });
});
