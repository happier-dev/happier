import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildRuntimeLocalHandoffMetadataForAgentMock = vi.hoisted(() => vi.fn(
    (
        agentId: string,
        params: Readonly<{
            machineId: string | null;
            workingDirectory: string | null;
            transcriptStorage: string | null;
            environmentVariables: Readonly<Record<string, string | undefined>> | null;
            vendorResumeId: string;
        }>,
    ): Readonly<Record<string, unknown>> => (
        agentId === 'opencode'
            ? { opencodeSessionId: params.vendorResumeId }
            : { claudeSessionId: params.vendorResumeId }
    ),
));

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
    readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/session/handoff/metadata/catalogHooks', () => ({
    buildRuntimeLocalHandoffMetadataForAgent:
        buildRuntimeLocalHandoffMetadataForAgentMock,
}));

vi.mock('@/agent/catalog/snapshot', () => ({
    readAgentCatalogSnapshot,
}));

import { buildHandoffSessionMetadataFromTrackedSession } from './buildHandoffSessionMetadataFromTrackedSession';

describe('buildHandoffSessionMetadataFromTrackedSession', () => {
    beforeEach(() => {
        buildRuntimeLocalHandoffMetadataForAgentMock.mockClear();
        readAgentCatalogSnapshot.mockReturnValue({
            agentDefinitionsById: new Map(),
            catalogEntriesById: {
                claude: { id: 'claude' },
                opencode: { id: 'opencode' },
                'acme.agent': { id: 'acme.agent' },
            },
        });
    });

    it('excludes External Session operation progress and presentation from Agent handoff leaves', () => {
        const inputMetadata = {
            machineId: 'machine-session-handoff',
            path: '/repo-source-current',
            homeDir: '/Users/target',
            flavor: 'claude',
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

        buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 122,
                happySessionId: 'sess_handoff_private_operation',
                vendorResumeId: 'provider-handoff-private-operation',
                happySessionMetadataFromLocalWebhook: inputMetadata,
            } as never,
            machineId: 'machine-session-handoff',
        });

        expect(buildRuntimeLocalHandoffMetadataForAgentMock)
            .toHaveBeenCalledWith('claude', {
                machineId: 'machine-session-handoff',
                workingDirectory: '/repo-source-current',
                transcriptStorage: null,
                environmentVariables: null,
                vendorResumeId: 'provider-handoff-private-operation',
            });
        expect(buildRuntimeLocalHandoffMetadataForAgentMock.mock.calls[0]?.[1])
            .not.toHaveProperty('externalSessionOperationV1');
        expect(buildRuntimeLocalHandoffMetadataForAgentMock.mock.calls[0]?.[1])
            .not.toHaveProperty('externalSessionOperationPresentationV1');
        expect(inputMetadata).toHaveProperty('externalSessionOperationV1');
        expect(inputMetadata).toHaveProperty('externalSessionOperationPresentationV1');
    });

    it('falls back to the persisted handoff overlay when the tracked session lost its webhook metadata', () => {
        const metadata = buildHandoffSessionMetadataFromTrackedSession({
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

    it('builds configured ACP fallback metadata when webhook metadata is missing', () => {
        const metadata = buildHandoffSessionMetadataFromTrackedSession({
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

    it('uses direct-session runtime identity when webhook metadata has no legacy flavor field', () => {
        const metadata = buildHandoffSessionMetadataFromTrackedSession({
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

    it('uses the installed external Agent identity for its catalog-owned handoff metadata', () => {
        const metadata = buildHandoffSessionMetadataFromTrackedSession({
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

        expect(buildRuntimeLocalHandoffMetadataForAgentMock).toHaveBeenCalledWith('acme.agent', {
            machineId: 'machine-session-handoff',
            workingDirectory: '/repo-acme',
            transcriptStorage: null,
            environmentVariables: null,
            vendorResumeId: 'acme-session-456',
        });
        expect(metadata).toEqual(expect.objectContaining({
            runtimeLocalMetadata: expect.objectContaining({
                claudeSessionId: 'acme-session-456',
            }),
        }));
    });

    it('does not apply an installed Agent handoff hook to a configured external runtime identity', () => {
        buildHandoffSessionMetadataFromTrackedSession({
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

        expect(buildRuntimeLocalHandoffMetadataForAgentMock).not.toHaveBeenCalled();
    });
});
