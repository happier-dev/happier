import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCurrentExecutionSurfacesForCatalogAgent } = vi.hoisted(() => ({
    resolveCurrentExecutionSurfacesForCatalogAgent: vi.fn(),
}));

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
    readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
    getSessionHostBridge: () => ({
        resolveCurrentExecutionSurfacesForCatalogAgent,
    }),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
    readAgentCatalogSnapshot,
}));

import { buildHandoffSessionMetadataFromTrackedSession } from './buildHandoffSessionMetadataFromTrackedSession';

describe('buildHandoffSessionMetadataFromTrackedSession', () => {
    beforeEach(() => {
        resolveCurrentExecutionSurfacesForCatalogAgent.mockReset();
        resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValue(null);
        readAgentCatalogSnapshot.mockReturnValue({
            agentDefinitionsById: new Map(),
            catalogEntriesById: {
                claude: { id: 'claude' },
                opencode: { id: 'opencode' },
                'acme.agent': { id: 'acme.agent' },
            },
        });
    });

    it('passes only canonical identity and descriptor facts to the current Agent handoff leaf', async () => {
        const inputMetadata = {
            machineId: 'machine-session-handoff',
            path: '/repo-source-current',
            homeDir: '/Users/target',
            flavor: 'claude',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'claude',
                agent: { configDir: '/descriptor-owned/.claude' },
            },
            externalSessionOperationV1: {
                v: 1,
                progress: { operationId: 'private-operation', revision: 6 },
            },
            externalSessionOperationPresentationV1: {
                v: 1,
                operationId: 'private-operation',
                revision: 6,
                kind: 'materialize',
                status: 'running',
                phase: 'publishing',
            },
        };

        const buildRuntimeLocalMetadata = vi.fn(async () => ({
            externalSessionSource: {
                kind: 'claudeConfig',
                configDir: '/descriptor-owned/.claude',
            },
        }));
        resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValueOnce({
            agentId: 'claude',
            backendId: 'claude.runtime',
            executionSurfaces: { handoff: { buildRuntimeLocalMetadata } },
        });

        const result = await buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 122,
                happySessionId: 'sess_handoff_private_operation',
                vendorResumeId: 'provider-handoff-private-operation',
                spawnOptions: {
                    transcriptStorage: 'direct',
                    environmentVariables: {
                        CLAUDE_CONFIG_DIR: '/tracked-environment-must-not-reach-leaf',
                    },
                },
                happySessionMetadataFromLocalWebhook: inputMetadata,
            } as never,
            machineId: 'machine-session-handoff',
        });

        expect(resolveCurrentExecutionSurfacesForCatalogAgent).toHaveBeenCalledWith('claude');
        expect(buildRuntimeLocalMetadata).toHaveBeenCalledWith({
            identity: {
                machineId: 'machine-session-handoff',
                workingDirectory: '/repo-source-current',
                transcriptStorage: 'direct',
                vendorResumeId: 'provider-handoff-private-operation',
            },
            runtimeDescriptorV1: inputMetadata.runtimeDescriptorV1,
        });
        expect(buildRuntimeLocalMetadata.mock.calls[0]?.[0])
            .not.toHaveProperty('externalSessionOperationV1');
        expect(buildRuntimeLocalMetadata.mock.calls[0]?.[0])
            .not.toHaveProperty('externalSessionOperationPresentationV1');
        expect(buildRuntimeLocalMetadata.mock.calls[0]?.[0])
            .not.toHaveProperty('environmentVariables');
        expect(inputMetadata).toHaveProperty('externalSessionOperationV1');
        expect(inputMetadata).toHaveProperty('externalSessionOperationPresentationV1');
        expect(result).toEqual(expect.objectContaining({
            runtimeLocalMetadata: expect.objectContaining({
                claudeSessionId: 'provider-handoff-private-operation',
                externalSessionV1: expect.objectContaining({
                    source: {
                        kind: 'claudeConfig',
                        configDir: '/descriptor-owned/.claude',
                    },
                }),
            }),
        }));
    });

    it('falls back to the persisted handoff overlay when the tracked session lost its webhook metadata', async () => {
        const metadata = await buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 123,
                happySessionId: 'sess_handoff_overlay_only',
                vendorResumeId: 'sess-handoff-direct',
            } as never,
            machineId: 'machine-session-handoff',
            localExportMetadataOverlay: {
                machineId: 'machine-session-handoff',
                path: '/repo-source-current',
                homeDir: '/Users/target',
                flavor: 'claude',
                handoffV1: {
                    v: 1,
                    sourceMachineId: 'machine_source',
                    targetMachineId: 'machine-session-handoff',
                    providerId: 'claude',
                    sessionStorageBefore: 'direct',
                    sessionStorageAfter: 'direct',
                    transportStrategy: 'direct_peer',
                    completedAtMs: 1,
                    sourceWorkspaceRootPath: '/repo-source-origin',
                    targetWorkspaceRootPath: '/repo-source-current',
                },
            },
        });

        expect(metadata).toEqual(expect.objectContaining({
            exportMetadata: expect.objectContaining({
                machineId: 'machine-session-handoff',
                path: '/repo-source-current',
                homeDir: '/Users/target',
                flavor: 'claude',
                handoffV1: expect.objectContaining({
                    sourceMachineId: 'machine_source',
                    targetMachineId: 'machine-session-handoff',
                }),
            }),
            runtimeLocalMetadata: expect.objectContaining({
                claudeSessionId: 'sess-handoff-direct',
            }),
        }));
    });

    it('builds configured ACP fallback metadata when webhook metadata is missing', async () => {
        const metadata = await buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 234,
                happySessionId: 'sess_configured_acp_fallback',
                spawnOptions: {
                    directory: '/repo-acp',
                    backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
                    environmentVariables: { HOME: '/Users/acp-home' },
                },
            } as never,
            machineId: 'machine-acp-fallback',
            fallbackHomeDir: '/Users/fallback',
        });

        expect(metadata).toEqual(expect.objectContaining({
            exportMetadata: expect.objectContaining({
                machineId: 'machine-acp-fallback',
                path: '/repo-acp',
                homeDir: '/Users/acp-home',
                flavor: 'acp:review-bot',
                acpConfiguredBackendV1: expect.objectContaining({
                    v: 1,
                    backendId: 'review-bot',
                    title: 'review-bot',
                    updatedAt: expect.any(Number),
                }),
            }),
        }));
    });

    it('uses direct-session runtime identity when webhook metadata has no legacy flavor field', async () => {
        const metadata = await buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 345,
                happySessionId: 'sess_direct_identity',
                vendorResumeId: 'sess-handoff-direct',
                happySessionMetadataFromLocalWebhook: {
                    machineId: 'machine-session-handoff',
                    path: '/repo-source-current',
                    homeDir: '/Users/target',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'opencode',
                        machineId: 'machine-session-handoff',
                        remoteSessionId: 'sess-handoff-direct',
                        source: {
                            kind: 'opencodeServer',
                            baseUrl: 'http://127.0.0.1:4096/',
                        },
                        linkedAtMs: 1,
                    },
                },
            } as never,
            machineId: 'machine-session-handoff',
        });

        expect(metadata).toEqual(expect.objectContaining({
            runtimeLocalMetadata: expect.objectContaining({
                opencodeSessionId: 'sess-handoff-direct',
            }),
        }));
    });

    it('resolves the installed external Agent identity through the current runtime surface', async () => {
        const metadata = await buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 456,
                happySessionId: 'sess-external-identity',
                vendorResumeId: 'acme-session-456',
                happySessionMetadataFromLocalWebhook: {
                    machineId: 'machine-session-handoff',
                    path: '/repo-acme',
                    homeDir: '/Users/acme',
                    flavor: 'claude',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'acme.agent',
                        agent: {},
                    },
                },
            } as never,
            machineId: 'machine-session-handoff',
        });

        expect(resolveCurrentExecutionSurfacesForCatalogAgent).toHaveBeenCalledWith('acme.agent');
        expect(metadata).not.toHaveProperty('runtimeLocalMetadata');
    });

    it('does not resolve a configured external runtime identity through an installed Agent handoff leaf', async () => {
        await buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 457,
                happySessionId: 'sess-configured-identity',
                vendorResumeId: 'configured-session-457',
                happySessionMetadataFromLocalWebhook: {
                    machineId: 'machine-session-handoff',
                    path: '/repo-configured',
                    homeDir: '/Users/configured',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'acp:review-bot',
                        agent: {},
                    },
                },
            } as never,
            machineId: 'machine-session-handoff',
        });

        expect(resolveCurrentExecutionSurfacesForCatalogAgent).not.toHaveBeenCalled();
    });
});
