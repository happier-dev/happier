import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';

import {
    buildSpawnHappySessionRpcParams,
    buildTrustedHiddenSystemSessionSpawnHappySessionRpcParams,
    type SpawnSessionOptions,
} from './spawnSessionPayload';

const EXTERNAL_AGENT_ID = 'example.machine-scoped-agent';

function publishMachineScopedTransportDescriptors(): void {
    publishProjectedAgentUiBehaviorDescriptors({
        machineId: 'machine-a',
        descriptorsByAgentId: {
            [EXTERNAL_AGENT_ID]: {
                kind: 'plugin.ui.v1',
                pluginId: 'example.machine-a',
                agentId: EXTERNAL_AGENT_ID,
                version: 1,
                behavior: {
                    payload: {
                        backendTransport: {
                            backendMode: { values: ['shared-mode'] },
                            runtimeHandleFields: ['backendMode'],
                            agentExtra: { owner: 'example.machine-a', schemaId: 'transport-a', v: 1 },
                        },
                    },
                },
            },
        },
    });
    publishProjectedAgentUiBehaviorDescriptors({
        machineId: 'machine-b',
        descriptorsByAgentId: {
            [EXTERNAL_AGENT_ID]: {
                kind: 'plugin.ui.v1',
                pluginId: 'example.machine-b',
                agentId: EXTERNAL_AGENT_ID,
                version: 2,
                behavior: {
                    payload: {
                        backendTransport: {
                            backendMode: { values: ['shared-mode'] },
                            runtimeHandleFields: ['backendMode'],
                            agentExtra: { owner: 'example.machine-b', schemaId: 'transport-b', v: 2 },
                        },
                    },
                },
            },
        },
    });
}

describe('buildSpawnHappySessionRpcParams', () => {
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    it('uses the target machine descriptor when building an external Agent launch', () => {
        publishMachineScopedTransportDescriptors();

        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-b',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: EXTERNAL_AGENT_ID },
            codexBackendMode: 'shared-mode' as never,
        });

        expect(params.runtimeDescriptorV1).toMatchObject({
            agentId: EXTERNAL_AGENT_ID,
            agent: {
                agentExtra: {
                    owner: 'example.machine-b',
                    schemaId: 'transport-b',
                    v: 2,
                },
            },
        });
    });

    it('does not let ordinary session creation place startup instructions on the daemon wire', () => {
        expectTypeOf<SpawnSessionOptions>()
            .not.toHaveProperty('agentSessionStartupInstructionsV1');
        const agentSessionStartupInstructionsV1 = {
            v: 1 as const,
            id: 'happier.global_voice_agent',
            revision: 1,
            instructions: 'Global Voice developer instructions.',
        };

        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            agentSessionStartupInstructionsV1,
        } as any)).not.toHaveProperty('agentSessionStartupInstructionsV1');
    });

    it('preserves the V1 carrier only through the trusted hidden-system-session builder', () => {
        const agentSessionStartupInstructionsV1 = {
            v: 1 as const,
            id: 'happier.global_voice_agent',
            revision: 1,
            instructions: 'Global Voice developer instructions.',
        };

        expect(buildTrustedHiddenSystemSessionSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        }, agentSessionStartupInstructionsV1)).toEqual(expect.objectContaining({
            agentSessionStartupInstructionsV1,
        }));
    });

    it('includes configured ACP backend targets and omits removed workspace linkage fields', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'custom-kiro', configuredBackendId: 'custom-kiro', sourceKind: 'configured' },
        }));
        expect(params).not.toHaveProperty('workspaceId');
        expect(params).not.toHaveProperty('workspaceLocationId');
        expect(params).not.toHaveProperty('workspaceCheckoutId');
    });

    it('prefers codexBackendMode over legacy experimentalCodexAcp when provided together', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            experimentalCodexAcp: true,
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
        }));
        expect(params).not.toHaveProperty('experimentalCodexAcp');
    });

    it('normalizes legacy experimentalCodexAcp onto canonical codexBackendMode when codexBackendMode is absent', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
        } as any)).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'acp',
            runtimeDescriptorV1: expect.objectContaining({
                v: 1,
                agentId: 'codex',
                agent: expect.objectContaining({
                    backendMode: 'acp',
                }),
            }),
        }));
    });

    it('prefers runtimeDescriptorV1 over legacy experimentalCodexAcp when codexBackendMode is absent', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-2',
                },
            },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-2',
                },
            },
        }));
        expect(params).not.toHaveProperty('experimentalCodexAcp');
    });

    it('ignores legacy agentRuntimeDescriptorV1 input when building the canonical spawn payload', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            agentRuntimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'legacy-thread',
                },
            },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        }));
        expect(params).not.toHaveProperty('codexBackendMode');
        expect(params).not.toHaveProperty('runtimeDescriptorV1');
        expect(params).not.toHaveProperty('agentRuntimeDescriptorV1');
    });

    it('derives runtimeDescriptorV1 for codex spawn requests when codexBackendMode is set', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'codex-session-1',
            codexBackendMode: 'appServer',
        } as any)).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: expect.objectContaining({
                v: 1,
                agentId: 'codex',
                agent: expect.objectContaining({
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-1',
                }),
            }),
        }));
    });

    it('does not emit codex transport fields when the target backend is not codex', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            codexBackendMode: 'acp',
            experimentalCodexAcp: true,
        } as any);

        expect(params).not.toHaveProperty('codexBackendMode');
        expect(params).not.toHaveProperty('runtimeDescriptorV1');
    });

    it('derives codex runtime descriptor for canonical codex backend targets', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: {
                kind: 'backend',
                backendId: 'codex',
                sourceKind: 'built_in',
            },
            resume: 'codex-session-canonical',
            codexBackendMode: 'acp',
        } as any);

        expect(params).toEqual(expect.objectContaining({
            codexBackendMode: 'acp',
            runtimeDescriptorV1: expect.objectContaining({
                v: 1,
                agentId: 'codex',
                agent: expect.objectContaining({
                    backendMode: 'acp',
                    providerSessionId: 'codex-session-canonical',
                }),
            }),
        }));
    });

    it('preserves account settings version hints for modern daemon spawn payloads', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            accountSettingsVersionHint: 14,
        } as any);

        expect(params).toEqual(expect.objectContaining({
            accountSettingsVersionHint: 14,
        }));
    });

    it('preserves spawnNonce while stripping the retired direct initialPrompt field', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
            initialPrompt: '  first prompt  ',
            spawnNonce: '  new-session-spawn-1  ',
        } as any);

        expect(params).toEqual(expect.objectContaining({
            spawnNonce: 'new-session-spawn-1',
        }));
        expect(params).not.toHaveProperty('initialPrompt');
    });

    it('does not emit the UI-only spawn attempt key in daemon payloads', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
            spawnNonce: 'new-session-spawn-1',
        } as any);

        expect(params).toEqual(expect.objectContaining({
            spawnNonce: 'new-session-spawn-1',
        }));
    });

    it('omits legacy spawn token passthrough when present on a compatibility-shaped input', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            token: 'legacy-spawn-token',
        } as any);

        expect(params).not.toHaveProperty('token');
    });

    it('preserves provider connection identity in the modern spawn payload', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            modelSelection: SessionModelSelectionV1Schema.parse({
                v: 1,
                updatedAt: 456,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'openai/gpt-5.5',
                },
            }),
        });

        expect(params.modelSelection?.ref.providerConnectionId).toBe('pc_work');
        expect(params).not.toHaveProperty('modelId');
    });

});
