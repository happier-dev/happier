import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import {
    ExternalSessionFollowFailureError,
} from '@/session/external/externalSessionFollowFailure';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';

const {
    emitExternalSessionTranscriptRefreshInvalidationMock,
    loadLinkedExternalSessionMock,
    loadLinkedExternalSessionFromRawMock,
    loadPersistedLinkedExternalSessionMock,
    readCredentialsMock,
    resolveExternalSessionObservationLinkInputMock,
    resolveGenerationBoundExternalSessionFollowSurfaceMock,
    updateSessionMetadataWithExternalSessionFollowPolicyMock,
    validateExternalMachineSourceMock,
} = vi.hoisted(() => ({
    emitExternalSessionTranscriptRefreshInvalidationMock: vi.fn(),
    loadLinkedExternalSessionMock: vi.fn(),
    loadLinkedExternalSessionFromRawMock: vi.fn(),
    loadPersistedLinkedExternalSessionMock: vi.fn(),
    readCredentialsMock: vi.fn(),
    resolveExternalSessionObservationLinkInputMock: vi.fn(),
    resolveGenerationBoundExternalSessionFollowSurfaceMock: vi.fn(),
    updateSessionMetadataWithExternalSessionFollowPolicyMock: vi.fn(),
    validateExternalMachineSourceMock: vi.fn(),
}));

vi.mock('@/api/session/external/secureRefresh/emitExternalSessionTranscriptRefreshInvalidation', () => ({
    emitExternalSessionTranscriptRefreshInvalidation:
        (...args: unknown[]) => emitExternalSessionTranscriptRefreshInvalidationMock(...args),
}));

vi.mock('@/api/session/external/security/validateExternalMachineSource', () => ({
    validateExternalMachineSource:
        (...args: unknown[]) => validateExternalMachineSourceMock(...args),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession:
        (...args: unknown[]) => loadLinkedExternalSessionMock(...args),
    loadLinkedExternalSessionFromRaw:
        (...args: unknown[]) => loadLinkedExternalSessionFromRawMock(...args),
    loadPersistedLinkedExternalSession:
        (...args: unknown[]) => loadPersistedLinkedExternalSessionMock(...args),
}));

vi.mock('@/persistence', () => ({
    readStoredCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('@/api/session/external/leases/resolveExternalSessionObservationLinkInput', () => ({
    resolveExternalSessionObservationLinkInput:
        (...args: unknown[]) => resolveExternalSessionObservationLinkInputMock(...args),
}));

vi.mock('@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata', () => ({
    updateSessionMetadataWithExternalSessionFollowPolicy:
        (...args: unknown[]) => updateSessionMetadataWithExternalSessionFollowPolicyMock(...args),
}));

vi.mock('./providerOpsResolution', () => ({
    resolveGenerationBoundExternalSessionFollowSurface:
        (...args: unknown[]) => resolveGenerationBoundExternalSessionFollowSurfaceMock(...args),
}));

import {
    executeExternalSessionAttachAction,
    executeExternalSessionDetachAction,
    executeExternalSessionFollowPolicySetAction,
} from './followLeaseActions';

describe('external-session follow lease actions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        validateExternalMachineSourceMock.mockResolvedValue({
            ok: true,
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
        });
        readCredentialsMock.mockResolvedValue({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array([1]) },
        });
        updateSessionMetadataWithExternalSessionFollowPolicyMock.mockResolvedValue(undefined);
        const defaultLoadedSession = {
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                linkGeneration: 'link-1',
                source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
                metadata: {
                    externalSessionV1: {
                        v: 1,
                        agentId: 'opencode',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
                        linkedAtMs: 1,
                    },
                },
                rawSession: {
                    id: 'session-1',
                    metadata: '{}',
                    metadataVersion: 1,
                },
            },
        } as const;
        loadLinkedExternalSessionMock.mockResolvedValue(defaultLoadedSession);
        loadLinkedExternalSessionFromRawMock.mockResolvedValue(
            defaultLoadedSession,
        );
        loadPersistedLinkedExternalSessionMock.mockResolvedValue(
            defaultLoadedSession,
        );
        resolveExternalSessionObservationLinkInputMock.mockResolvedValue({
            resource: {
                pluginId: 'happier.opencode',
                agentLocalId: 'opencode',
                pluginGeneration: 'plugin-1',
                resourceKey: 'resource-1',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-1',
                linkKey: 'native-remote-1',
                linkedSource: {
                    source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
                    remoteSessionId: 'remote-1',
                    linkData: {},
                },
                changeObservation: 'observe_resource',
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1,
                    agent: { pluginId: 'happier.opencode', localId: 'opencode' },
                    source: { kind: 'opencodeServer', contractVersion: 1 },
                },
                linkGeneration: 'link-1',
            },
        });
    });

    it('rejects a stale viewer identity before creating follow demand or a lease', async () => {
        loadLinkedExternalSessionMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'invalid_request',
            error: 'linked_session_identity_mismatch',
        });
        const attach = vi.fn();
        const reconcileTranscriptDemand = vi.fn();

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-stale',
        }, {
            followLeaseManager: { attach },
            observationProjection: { reconcileTranscriptDemand },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_request',
            error: 'linked_session_identity_mismatch',
        });

        expect(loadLinkedExternalSessionMock).toHaveBeenCalledWith({
            credentials: expect.any(Object),
            sessionId: 'session-1',
            machineId: 'machine-1',
            expectedIdentity: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            },
        });
        expect(validateExternalMachineSourceMock).not.toHaveBeenCalled();
        expect(attach).not.toHaveBeenCalled();
        expect(reconcileTranscriptDemand).not.toHaveBeenCalled();
        expect(resolveGenerationBoundExternalSessionFollowSurfaceMock)
            .not.toHaveBeenCalled();
    });

    it('rejects a stale background-follow identity before persistence or lease effects', async () => {
        loadPersistedLinkedExternalSessionMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'invalid_request',
            error: 'linked_session_identity_mismatch',
        });
        const setBackgroundFollowEnabled = vi.fn();

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/relinked' },
            enabled: true,
        }, {
            followLeaseManager: { setBackgroundFollowEnabled },
            observationProjection: { reconcileTranscriptDemand: vi.fn() },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_request',
            error: 'linked_session_identity_mismatch',
        });

        expect(loadPersistedLinkedExternalSessionMock).toHaveBeenCalledWith({
            credentials: expect.any(Object),
            sessionId: 'session-1',
            machineId: 'machine-1',
            expectedIdentity: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'opencodeServer', directory: '/tmp/relinked' },
            },
        });
        expect(updateSessionMetadataWithExternalSessionFollowPolicyMock)
            .not.toHaveBeenCalled();
        expect(setBackgroundFollowEnabled).not.toHaveBeenCalled();
        expect(validateExternalMachineSourceMock).not.toHaveBeenCalled();
        expect(loadLinkedExternalSessionFromRawMock).not.toHaveBeenCalled();
    });

    it('routes two viewers through one generation-qualified physical follower', async () => {
        const retirement = new AbortController();
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'happier_external_cursor_v1:dGFpbA',
                    hasMore: false,
                    truncated: false,
                })),
                readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' })),
            },
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
                retirementSignal: retirement.signal,
            },
        });
        const reconcileTranscriptDemand = vi.fn(async (
            _input: Readonly<{ demanded: boolean }>,
        ) => ({ state: 'observing' as const }));
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const context = {
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: { reconcileTranscriptDemand },
            emitExternalSessionTranscriptUpdate: vi.fn(async () => {}),
        } as never;
        const request = {
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            ttlMs: 30_000,
        };

        const first = await executeExternalSessionAttachAction(
            { ...request, leaseId: 'viewer-1' },
            context,
        );
        const second = await executeExternalSessionAttachAction(
            { ...request, leaseId: 'viewer-2' },
            context,
        );

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(reconcileTranscriptDemand.mock.calls.filter(
            ([input]) => input.demanded === true,
        )).toHaveLength(1);

        await executeExternalSessionDetachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            leaseId: 'viewer-1',
        }, context);
        expect(reconcileTranscriptDemand.mock.calls.filter(
            ([input]) => input.demanded === false,
        )).toHaveLength(0);

        await executeExternalSessionDetachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            leaseId: 'viewer-2',
        }, context);
        expect(reconcileTranscriptDemand.mock.calls.filter(
            ([input]) => input.demanded === false,
        )).toHaveLength(1);
    });

    it('preserves a provider failure from initial viewer follow acquisition', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(async () => {
                    throw new ExternalSessionProviderFailureError({
                        code: 'agent_unavailable',
                        message: 'OpenCode endpoint unavailable',
                        operation: 'pageTranscript',
                        retryable: true,
                    });
                }),
                readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' })),
            },
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
            },
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-provider-failure',
        }, {
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(async () => ({ state: 'observing' })),
            },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'agent_unavailable',
            retryable: true,
        });

        await followLeaseManager.dispose();
    });

    it('admits a grouping-only Codex viewer through canonical descriptor hydration', async () => {
        const source = {
            kind: 'codexHome',
            home: 'user',
            homePath: '/tmp/codex-home',
        } as const;
        validateExternalMachineSourceMock.mockResolvedValueOnce({
            ok: true,
            source,
        });
        loadLinkedExternalSessionMock.mockResolvedValue({
            ok: true,
            session: {
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'codex-thread-1',
                linkGeneration: 'link-codex-1',
                source,
                metadata: {},
            },
        });
        resolveExternalSessionObservationLinkInputMock.mockResolvedValueOnce({
            resource: {
                pluginId: 'happier.agent.codex',
                agentLocalId: 'codex',
                pluginGeneration: 'plugin-codex-1',
                resourceKey: '/tmp/codex-home',
            },
            link: {
                sessionId: 'session-codex-1',
                linkGeneration: 'link-codex-1',
                linkKey: 'codex-thread-1',
                linkedSource: {
                    source,
                    remoteSessionId: 'codex-thread-1',
                    linkData: { source },
                },
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    source: {
                        kind: 'codexHome',
                        contractVersion: 1,
                    },
                },
                linkGeneration: 'link-codex-1',
            },
        });
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValueOnce({
            providerOps: {
                pageTranscript: vi.fn(async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'happier_external_cursor_v1:dGFpbA',
                    hasMore: false,
                    truncated: false,
                })),
                readAfterTranscript: vi.fn(async () => ({
                    outcome: 'already_current',
                })),
            },
            resource: {
                linkGeneration: 'link-codex-1',
                pluginGeneration: 'plugin-codex-1',
            },
        });
        const reconcileTranscriptDemand = vi.fn(async (
            input: Readonly<{ demanded: boolean }>,
        ) => input.demanded
            ? { state: 'observing' as const }
            : { state: 'not-demanded' as const });
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const context = {
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: { reconcileTranscriptDemand },
            emitExternalSessionTranscriptUpdate: vi.fn(async () => {}),
        } as never;

        const response = await executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-codex-1',
            agentId: 'codex',
            remoteSessionId: 'codex-thread-1',
            source,
            leaseId: 'viewer-codex-1',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:YzA',
        }, context);

        expect(response).toEqual(expect.objectContaining({
            ok: true,
            leaseId: 'viewer-codex-1',
        }));
        expect(reconcileTranscriptDemand).toHaveBeenCalledWith(
            expect.objectContaining({
                demanded: true,
                resolved: expect.objectContaining({
                    link: expect.objectContaining({
                        linkGeneration: 'link-codex-1',
                        linkKey: 'codex-thread-1',
                    }),
                }),
            }),
        );

        await followLeaseManager.dispose();
    });

    it('admits a cursor-qualified OpenCode viewer without a physical follow lease', async () => {
        const resource = {
            linkGeneration: 'link-1',
            pluginGeneration: 'plugin-1',
        };
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'happier_external_cursor_v1:dGFpbA',
                    hasMore: false,
                    truncated: false,
                })),
                readAfterTranscript: vi.fn(async () => ({
                    outcome: 'already_current',
                })),
            },
            resource,
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const observationRelease = vi.fn(async () => {});
        const reconcileTranscriptDemand = vi.fn(async (
            input: Readonly<{ demanded: boolean }>,
        ) => input.demanded
            ? { state: 'observing', release: observationRelease }
            : { state: 'not-demanded' });
        const deviceLocalSecretStorage = {
            deriveOpaqueIdentity: vi.fn(() => 'a'.repeat(64)),
        } as never;
        const context = {
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: { reconcileTranscriptDemand },
            deviceLocalSecretStorage,
            emitExternalSessionTranscriptUpdate: vi.fn(async () => {}),
        } as never;

        const response = await executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-opencode',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:YzA',
        }, context);

        expect(response).toEqual(expect.objectContaining({
            ok: true,
            leaseId: 'viewer-opencode',
            acceptedTailCursor: 'happier_external_cursor_v1:YzA',
        }));
        await expect(followLeaseManager.requestTranscriptRefresh({
            sessionId: 'session-1',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(emitExternalSessionTranscriptRefreshInvalidationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'session-1',
                cursor: 'happier_external_cursor_v1:YzA',
                isCurrent: expect.any(Function),
                deviceLocalSecretStorage,
            }),
        );
        expect(reconcileTranscriptDemand).toHaveBeenCalledWith(expect.objectContaining({
            demanded: true,
            resolved: expect.objectContaining({
                link: expect.objectContaining({
                    changeObservation: 'observe_resource',
                    linkGeneration: 'link-1',
                }),
            }),
        }));

        await executeExternalSessionDetachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            leaseId: 'viewer-opencode',
        }, context);
        expect(reconcileTranscriptDemand).toHaveBeenLastCalledWith(expect.objectContaining({
            demanded: false,
        }));
    });

    it('maps viewer capacity exhaustion to a stable typed availability response', async () => {
        const resource = {
            linkGeneration: 'link-1',
            pluginGeneration: 'plugin-1',
        };
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            resource,
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const context = {
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(async () => ({
                    state: 'observing',
                })),
            },
            emitExternalSessionTranscriptUpdate: vi.fn(async () => {}),
        } as never;
        const request = {
            machineId: 'machine-1',
            sessionId: 'session-capacity',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:YzA',
        };

        for (let index = 0; index < 64; index += 1) {
            await expect(executeExternalSessionAttachAction({
                ...request,
                leaseId: `viewer-${index}`,
                acceptedTailCursor:
                    `happier_external_cursor_v1:${Buffer.from(`cursor-${index}`).toString('base64url')}`,
            }, context)).resolves.toEqual(expect.objectContaining({ ok: true }));
        }

        await expect(executeExternalSessionAttachAction({
            ...request,
            leaseId: 'viewer-over-capacity',
        }, context)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_viewer_capacity_exceeded',
        });

        emitExternalSessionTranscriptRefreshInvalidationMock.mockClear();
        await expect(followLeaseManager.requestTranscriptRefresh({
            sessionId: 'session-capacity',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(emitExternalSessionTranscriptRefreshInvalidationMock).toHaveBeenCalledTimes(64);
        expect(new Set(
            emitExternalSessionTranscriptRefreshInvalidationMock.mock.calls
                .map(([input]) => input.cursor),
        ).size).toBe(64);

        await followLeaseManager.dispose();
    });

    it('fails closed for Oh My Pi background follow while its observation is reconciliation-only', async () => {
        const source = { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' } as const;
        validateExternalMachineSourceMock.mockResolvedValueOnce({ ok: true, source });
        const loadedOhMyPiSession = {
            ok: true,
            session: {
                agentId: 'ohMyPi',
                machineId: 'machine-1',
                remoteSessionId: 'remote-omp',
                linkGeneration: 'link-omp',
                source,
                metadata: {},
                rawSession: { id: 'session-omp' },
            },
        } as const;
        loadPersistedLinkedExternalSessionMock.mockResolvedValueOnce(
            loadedOhMyPiSession,
        );
        loadLinkedExternalSessionFromRawMock.mockResolvedValueOnce(
            loadedOhMyPiSession,
        );
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValueOnce({
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            resource: {
                linkGeneration: 'link-omp',
                pluginGeneration: 'plugin-omp',
            },
        });
        resolveExternalSessionObservationLinkInputMock.mockResolvedValueOnce({
            resource: {
                pluginId: 'happier.ohmypi',
                agentLocalId: 'ohmypi',
                pluginGeneration: 'plugin-omp',
                resourceKey: '/tmp/omp',
            },
            link: {
                sessionId: 'session-omp',
                linkGeneration: 'link-omp',
                linkKey: 'remote-omp',
                linkedSource: {
                    source,
                    remoteSessionId: 'remote-omp',
                    linkData: {},
                },
                changeObservation: 'reconcile_only',
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1,
                    agent: { pluginId: 'happier.ohmypi', localId: 'ohmypi' },
                    source: { kind: 'ohMyPiAgentDir', contractVersion: 1 },
                },
                linkGeneration: 'link-omp',
            },
        });
        const context = {
            machineId: 'machine-1',
            followLeaseManager: createExternalSessionFollowLeaseManager(),
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(),
            },
        } as never;

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-omp',
            agentId: 'ohMyPi',
            remoteSessionId: 'remote-omp',
            source,
            enabled: true,
        }, context)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'background_follow_not_supported',
        });
    });

    it('preserves a provider failure from initial background-follow acquisition', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(async () => {
                    throw new ExternalSessionProviderFailureError({
                        code: 'agent_unavailable',
                        message: 'OpenCode endpoint unavailable',
                        operation: 'pageTranscript',
                        retryable: true,
                    });
                }),
                readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' })),
            },
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
            },
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            enabled: true,
        }, {
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(async () => ({ state: 'observing' })),
            },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'agent_unavailable',
            retryable: true,
        });

        expect(updateSessionMetadataWithExternalSessionFollowPolicyMock).not.toHaveBeenCalled();
        await followLeaseManager.dispose();
    });

    it('validates Agent source only after active persisted follow identity is admitted', async () => {
        validateExternalMachineSourceMock.mockRejectedValueOnce(
            new Error('Agent source unavailable'),
        );
        const manager = createExternalSessionFollowLeaseManager();

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: {
                kind: 'opencodeServer',
                directory: '/tmp/workspace',
            },
            enabled: true,
        }, {
            followLeaseManager: manager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(),
            },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'follow_policy_set_failed',
        });

        expect(
            loadPersistedLinkedExternalSessionMock,
        ).toHaveBeenCalledOnce();
        expect(validateExternalMachineSourceMock).toHaveBeenCalledOnce();
        expect(loadLinkedExternalSessionFromRawMock).not.toHaveBeenCalled();
        expect(
            updateSessionMetadataWithExternalSessionFollowPolicyMock,
        ).not.toHaveBeenCalled();
        await manager.dispose();
    });

    it('disables durable background follow without resolving unavailable Agent work', async () => {
        loadPersistedLinkedExternalSessionMock.mockResolvedValueOnce({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                linkGeneration: 'link-1',
                source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
                metadata: {},
                rawSession: {
                    id: 'session-disable-agent-unavailable',
                    metadata: '{}',
                    metadataVersion: 1,
                },
            },
        });
        resolveGenerationBoundExternalSessionFollowSurfaceMock
            .mockRejectedValueOnce(new Error('Agent unavailable'));
        const reconcilePassiveFollowSession = vi.fn(async () => ({
            status: 'settled' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-disable-agent-unavailable',
            enabled: true,
        });

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-disable-agent-unavailable',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            enabled: false,
        }, {
            followLeaseManager: manager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(),
            },
            reconcilePassiveFollowSession,
        } as never)).resolves.toEqual(expect.objectContaining({
            ok: true,
            enabled: false,
            leaseActive: false,
        }));

        expect(
            resolveGenerationBoundExternalSessionFollowSurfaceMock,
        ).not.toHaveBeenCalled();
        expect(validateExternalMachineSourceMock).not.toHaveBeenCalled();
        expect(loadLinkedExternalSessionMock).not.toHaveBeenCalled();
        expect(loadLinkedExternalSessionFromRawMock).not.toHaveBeenCalled();
        expect(
            resolveExternalSessionObservationLinkInputMock,
        ).not.toHaveBeenCalled();
        expect(reconcilePassiveFollowSession).toHaveBeenCalledExactlyOnceWith(
            'session-disable-agent-unavailable',
        );
        await manager.dispose();
    });

    it('persists archived Enable intent without resolving or acquiring Agent work', async () => {
        loadPersistedLinkedExternalSessionMock.mockResolvedValueOnce({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                linkGeneration: 'link-1',
                source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
                metadata: {},
                rawSession: {
                    id: 'session-archived-enable',
                    archivedAt: 3_000,
                    metadata: '{}',
                    metadataVersion: 1,
                },
            },
        });
        resolveGenerationBoundExternalSessionFollowSurfaceMock
            .mockRejectedValueOnce(new Error('Agent unavailable'));
        const reconcilePassiveFollowSession = vi.fn(async () => ({
            status: 'settled' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-archived-enable',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            enabled: true,
        }, {
            followLeaseManager: manager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(),
            },
            reconcilePassiveFollowSession,
        } as never)).resolves.toEqual(expect.objectContaining({
            ok: true,
            enabled: true,
            leaseActive: false,
        }));

        expect(
            resolveGenerationBoundExternalSessionFollowSurfaceMock,
        ).not.toHaveBeenCalled();
        expect(validateExternalMachineSourceMock).not.toHaveBeenCalled();
        expect(loadLinkedExternalSessionMock).not.toHaveBeenCalled();
        expect(loadLinkedExternalSessionFromRawMock).not.toHaveBeenCalled();
        expect(
            resolveExternalSessionObservationLinkInputMock,
        ).not.toHaveBeenCalled();
        expect(manager.isBackgroundFollowEnabled(
            'session-archived-enable',
        )).toBe(true);
        expect(manager.isSessionSuspended({
            sessionId: 'session-archived-enable',
            reason: 'session_archived',
        })).toBe(true);
        expect(reconcilePassiveFollowSession).toHaveBeenCalledExactlyOnceWith(
            'session-archived-enable',
        );
        await manager.dispose();
    });

    it('does not report Disable settled when passive cleanup is unavailable', async () => {
        loadPersistedLinkedExternalSessionMock.mockResolvedValueOnce({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                linkGeneration: 'link-1',
                source: {
                    kind: 'opencodeServer',
                    directory: '/tmp/workspace',
                },
                metadata: {},
                rawSession: {
                    id: 'session-disable-cleanup-unavailable',
                    metadata: '{}',
                    metadataVersion: 1,
                },
            },
        });
        const manager = createExternalSessionFollowLeaseManager();
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-disable-cleanup-unavailable',
            enabled: true,
        });

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-disable-cleanup-unavailable',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: {
                kind: 'opencodeServer',
                directory: '/tmp/workspace',
            },
            enabled: false,
        }, {
            followLeaseManager: manager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(),
            },
            reconcilePassiveFollowSession: async () => ({
                status: 'unavailable',
            }),
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'follow_policy_reconciliation_unavailable',
        });

        expect(
            updateSessionMetadataWithExternalSessionFollowPolicyMock,
        ).toHaveBeenCalledOnce();
        expect(manager.isBackgroundFollowEnabled(
            'session-disable-cleanup-unavailable',
        )).toBe(false);
        await manager.dispose();
    });

    it.each([
        ['a concurrent dual-row disagreement', 'linked_session_reconciliation_required'],
        ['a concurrent relink', 'linked_session_identity_mismatch'],
    ] as const)('surfaces %s at the follow-policy mutation boundary', async (_label, error) => {
        const retirement = new AbortController();
        loadPersistedLinkedExternalSessionMock.mockResolvedValueOnce({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                linkGeneration: 'link-1',
                source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
                metadata: {},
                rawSession: {
                    metadata: '{}',
                    metadataVersion: 1,
                },
            },
        });
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
                retirementSignal: retirement.signal,
            },
        });
        updateSessionMetadataWithExternalSessionFollowPolicyMock.mockRejectedValueOnce(
            new Error(error),
        );
        const manager = createExternalSessionFollowLeaseManager();

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            enabled: false,
        }, {
            followLeaseManager: manager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(async () => ({
                    state: 'observing',
                })),
            },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_request',
            error,
        });
        expect(manager.isBackgroundFollowEnabled('session-1')).toBe(false);
        await manager.dispose();
    });

    it('awaits private passive-session reconciliation before returning successful Disable', async () => {
        loadPersistedLinkedExternalSessionMock.mockResolvedValueOnce({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                linkGeneration: 'link-1',
                source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
                metadata: {},
                rawSession: {
                    id: 'session-1',
                    metadata: '{}',
                    metadataVersion: 1,
                },
            },
        });
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
            },
        });
        let finishPassiveReconcile!: () => void;
        const passiveReconcileBarrier = new Promise<void>((resolve) => {
            finishPassiveReconcile = resolve;
        });
        const reconcilePassiveFollowSession = vi.fn(async () => {
            await passiveReconcileBarrier;
            return { status: 'settled' as const };
        });
        const manager = createExternalSessionFollowLeaseManager();
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-1',
            enabled: true,
        });

        let settled = false;
        const response = executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            enabled: false,
        }, {
            followLeaseManager: manager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(async () => ({
                    state: 'observing',
                })),
            },
            reconcilePassiveFollowSession,
        } as never).then((result) => {
            settled = true;
            return result;
        });

        await vi.waitFor(() => {
            expect(reconcilePassiveFollowSession).toHaveBeenCalledExactlyOnceWith(
                'session-1',
            );
        });
        expect(settled).toBe(false);
        finishPassiveReconcile();

        await expect(response).resolves.toEqual(expect.objectContaining({
            ok: true,
            enabled: false,
            leaseActive: false,
        }));
        expect(manager.isBackgroundFollowEnabled('session-1')).toBe(false);
        await manager.dispose();
    });

    it('reports an attach with no current Agent generation as a typed availability failure', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockReset();
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockRejectedValue(
            new ExternalSessionFollowFailureError(
                'agent_unavailable',
                'Missing current external-session Agent generation for opencode',
            ),
        );
        const attach = vi.fn();

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-agent-unavailable',
        }, {
            followLeaseManager: { attach },
            observationProjection: { reconcileTranscriptDemand: vi.fn() },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_agent_unavailable',
            retryable: true,
        });
        expect(attach).not.toHaveBeenCalled();
    });

    it('reports an attach whose linked source changed during acquisition as a typed source-changed failure', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockReset();
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            resource: { linkGeneration: 'link-1', pluginGeneration: 'plugin-1' },
        });
        const attach = vi.fn(async () => {
            throw new ExternalSessionFollowFailureError(
                'source_changed',
                'External Session link changed before follow acquisition',
            );
        });

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-source-changed',
        }, {
            followLeaseManager: { attach },
            observationProjection: { reconcileTranscriptDemand: vi.fn() },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_source_changed',
            retryable: true,
        });
    });

    it('reports an attach whose live follow was not admitted as a typed follow-unavailable failure', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockReset();
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            resource: { linkGeneration: 'link-1', pluginGeneration: 'plugin-1' },
        });
        const attach = vi.fn(async () => {
            throw new ExternalSessionFollowFailureError(
                'follow_unavailable',
                'External Session live follow is unavailable: reconcile-only',
            );
        });

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-follow-unavailable',
        }, {
            followLeaseManager: { attach },
            observationProjection: { reconcileTranscriptDemand: vi.fn() },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_follow_unavailable',
            retryable: false,
        });
    });

    it('reports an attach against a disposed follow-lease owner as a typed daemon failure', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockReset();
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockResolvedValue({
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            resource: { linkGeneration: 'link-1', pluginGeneration: 'plugin-1' },
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        await followLeaseManager.dispose();

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-disposed',
        }, {
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(async () => ({ state: 'observing' })),
            },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_daemon_unavailable',
            retryable: true,
        });
    });

    it('reports a typed source-validation failure of attach without collapsing it to an internal error', async () => {
        validateExternalMachineSourceMock.mockRejectedValueOnce(
            new ExternalSessionFollowFailureError(
                'agent_unavailable',
                'Missing current external-session Agent operations for opencode',
            ),
        );
        const attach = vi.fn();

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-validate-source',
        }, {
            followLeaseManager: { attach },
            observationProjection: { reconcileTranscriptDemand: vi.fn() },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_agent_unavailable',
            retryable: true,
        });
        expect(attach).not.toHaveBeenCalled();
    });

    it('keeps a genuinely unexpected attach throw on the opaque internal-error envelope', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockReset();
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockRejectedValue(
            new Error('unexpected follow surface defect'),
        );
        const attach = vi.fn();

        await expect(executeExternalSessionAttachAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            leaseId: 'viewer-unexpected',
        }, {
            followLeaseManager: { attach },
            observationProjection: { reconcileTranscriptDemand: vi.fn() },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'external_session_attach_failed',
        });
        expect(attach).not.toHaveBeenCalled();
    });

    it('reports a typed background-follow failure with the same corridor classification', async () => {
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockReset();
        resolveGenerationBoundExternalSessionFollowSurfaceMock.mockRejectedValue(
            new ExternalSessionFollowFailureError(
                'source_changed',
                'External-session Agent generation retired while resolving opencode',
            ),
        );
        const manager = createExternalSessionFollowLeaseManager();

        await expect(executeExternalSessionFollowPolicySetAction({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
            source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
            enabled: true,
        }, {
            followLeaseManager: manager,
            observationProjection: { reconcileTranscriptDemand: vi.fn() },
        } as never)).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_source_changed',
            retryable: true,
        });
        await manager.dispose();
    });
});
