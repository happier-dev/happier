import { describe, expect, it, vi } from 'vitest';

const createAuthorizationMock = vi.hoisted(() => vi.fn(
    async (input: Readonly<{ descriptor: unknown }>) => ({
        authorization: {
            tokenHash: 'token-hash',
            descriptor: input.descriptor,
            tokenFilePath: '/tmp/agent-runtime-token',
        },
        childEnv: {
            HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE:
                '/tmp/agent-runtime-token',
        },
        cleanupTokenFile: async () => undefined,
    }),
));

vi.mock('../agentRuntime/sessionBridgeAuthorization', () => ({
    createAgentRuntimeSessionBridgeAuthorization: createAuthorizationMock,
}));

import {
    prepareAgentRuntimeSessionBridgeForLease,
} from './prepareAgentRuntimeSessionBridge';

describe('prepareAgentRuntimeSessionBridgeForLease', () => {
    it('carries the activated manifest authority without transferring the registry lease', async () => {
        const agent = {
            id: 'claude',
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
                    manifestDigest: 'manifest:voice-provider',
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
                generation: 'generation-1',
                immutableGenerationId: null,
                hasPrimaryRuntime: true,
            }]]),
            permissionsByPluginId: new Map([[
                'happier.agent.claude',
                new Set(['session.hooks.control', 'process.spawn']),
            ]]),
            runtimeCapabilitiesByPluginId: new Map([[
                'happier.agent.claude',
                new Set(['sessionHooks', 'agents']),
            ]]),
            activateContributionsOnDemand: async () => [],
            resolveContributionRuntimeLifecycle: vi.fn(() => ({
                generation: 'provider-generation-9',
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
            })),
        };

        const prepared = await prepareAgentRuntimeSessionBridgeForLease({
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
            runtimeSurfaces: {
                terminal: true,
                realtimeConversation: {
                    providers: [{
                        identity: {
                            pluginId: 'happier.voice.claude-realtime',
                            localId: 'conversation',
                        },
                        manifestDigest: 'manifest:voice-provider',
                        generation: 'provider-generation-9',
                        declaration: registry.contributes.voiceProviders[0]
                            .definition,
                    }],
                },
            },
            runtimeAuthority: {
                permissions: ['process.spawn', 'session.hooks.control'],
                runtimeCapabilities: ['agents', 'sessionHooks'],
            },
        }));
        expect(prepared?.authorization.descriptor).not.toHaveProperty('registry');
        expect(prepared?.authorization.descriptor).not.toHaveProperty('lease');
        expect(registry.resolveContributionRuntimeLifecycle)
            .toHaveBeenCalledWith({
                pluginId: 'happier.voice.claude-realtime',
                manifestDigest: 'manifest:voice-provider',
            });
    });
});
