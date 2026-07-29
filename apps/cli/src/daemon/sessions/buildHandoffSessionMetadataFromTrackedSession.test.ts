import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildRuntimeLocalHandoffMetadataForAgentMock = vi.hoisted(() => vi.fn(
    (
        agentId: string,
        params: Readonly<{
            vendorResumeId: string;
            metadata: Readonly<Record<string, unknown>>;
        }>,
    ): Readonly<Record<string, unknown>> => (
        agentId === 'opencode'
            ? { opencodeSessionId: params.vendorResumeId }
            : { claudeSessionId: params.vendorResumeId }
    ),
));

vi.mock('@/session/handoff/metadata/catalogHooks', () => ({
    buildRuntimeLocalHandoffMetadataForAgent:
        buildRuntimeLocalHandoffMetadataForAgentMock,
}));

import { buildHandoffSessionMetadataFromTrackedSession } from './buildHandoffSessionMetadataFromTrackedSession';

describe('buildHandoffSessionMetadataFromTrackedSession', () => {
    beforeEach(() => {
        buildRuntimeLocalHandoffMetadataForAgentMock.mockClear();
    });

    it('excludes owner-only External Session operation progress from Agent handoff leaves', () => {
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
            .toHaveBeenCalledWith('claude', expect.objectContaining({
                metadata: expect.objectContaining({
                    path: '/repo-source-current',
                    externalSessionOperationPresentationV1:
                        inputMetadata.externalSessionOperationPresentationV1,
                }),
            }));
        expect(buildRuntimeLocalHandoffMetadataForAgentMock.mock.calls[0]?.[1].metadata)
            .not.toHaveProperty('externalSessionOperationV1');
        expect(inputMetadata).toHaveProperty('externalSessionOperationV1');
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
});
