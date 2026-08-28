import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
    FeaturesResponseSchema,
    type ExternalAgentObservationSnapshotV1,
} from '@happier-dev/protocol';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

const mocks = vi.hoisted(() => ({
    acquireRuntimeRegistryLease: vi.fn(),
    describeResource: vi.fn(),
    listSessionMarkers: vi.fn(),
    loadLinkedExternalSession: vi.fn(),
    readCredentials: vi.fn(),
    resolveExternalLinkedTakeoverWriterSafety: vi.fn(),
    resolveSource: vi.fn(),
    resolveLinkedIdentity: vi.fn(),
    isExternalTakeoverLaunchAvailable: vi.fn(),
    updateSessionMetadataWithRetry: vi.fn(),
    validateExternalMachineSource: vi.fn(),
    verifyProcessLiveness: vi.fn(),
}));

vi.mock('@/daemon/sessionRegistry', () => ({
    listSessionMarkers: mocks.listSessionMarkers,
}));
vi.mock('@/daemon/processLivenessVerifier', () => ({
    verifySessionMarkerProcessLiveness: mocks.verifyProcessLiveness,
}));
vi.mock('@/api/session/external/security/validateExternalMachineSource', () => ({
    validateExternalMachineSource: mocks.validateExternalMachineSource,
}));
vi.mock('@/persistence', () => ({
    readStoredCredentials: mocks.readCredentials,
}));
vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession: mocks.loadLinkedExternalSession,
}));
vi.mock('@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions', () => ({
    isExternalTakeoverLaunchAvailable: mocks.isExternalTakeoverLaunchAvailable,
}));
vi.mock('@/api/session/external/takeover/resolveExternalLinkedTakeoverWriterSafety', () => ({
    resolveExternalLinkedTakeoverWriterSafety:
        mocks.resolveExternalLinkedTakeoverWriterSafety,
}));
vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: mocks.acquireRuntimeRegistryLease,
}));
vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
    updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));

import { executeExternalSessionStatusGetAction } from './statusAction';

const qualifiedLinkIdentity = {
    v: 1,
    agent: {
        pluginId: 'happier.opencode',
        localId: 'opencode',
    },
    source: {
        kind: 'opencodeServer',
        contractVersion: 1,
    },
} as const;

function snapshot(
    status: ExternalAgentObservationSnapshotV1['status'],
): ExternalAgentObservationSnapshotV1 {
    return status === 'unknown'
        ? {
            v: 1,
            qualifiedLinkIdentity,
            linkGeneration: '1000',
            status,
        }
        : {
            v: 1,
            qualifiedLinkIdentity,
            linkGeneration: '1000',
            status,
            observedAtMs: 1_000,
            expiresAtMs: 2_000,
        };
}

function readyServerFeatures(
    currentPublicationFenceVersion: number,
): CliServerFeaturesSnapshot {
    const features = FeaturesResponseSchema.parse({
        features: {},
        capabilities: {},
    });
    return {
        status: 'ready',
        features: {
            ...features,
            capabilities: {
                ...features.capabilities,
                session: {
                    ...features.capabilities.session,
                    externalImport: {
                        publicationFenceVersion: currentPublicationFenceVersion,
                    },
                },
            },
        },
    };
}

function actionContext(
    externalAgent: ExternalAgentObservationSnapshotV1 | null,
    getServerFeaturesSnapshot = vi.fn<
        () => CliServerFeaturesSnapshot | undefined
    >(() => readyServerFeatures(
        EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
    )),
) {
    const reconcileStatusLink = vi.fn(async () => ({
        reconciliation: {
            state: 'reconciled' as const,
            requestedLinkKeys: 1,
        },
        snapshot: externalAgent,
    }));
    return {
        context: {
            followLeaseManager: {},
            operationExclusion: {},
            observationProjection: {
                reconcileStatusLink,
            },
            getServerFeaturesSnapshot,
        },
        reconcileStatusLink,
        getServerFeaturesSnapshot,
    };
}

const request = {
    machineId: 'machine-1',
    sessionId: 'session-1',
    agentId: 'opencode',
    remoteSessionId: 'remote-1',
    source: {
        kind: 'opencodeServer',
        directory: null,
    },
} as const;

function setVerifiedStoppedOwnerMarker(): void {
    mocks.listSessionMarkers.mockResolvedValue([{
        pid: process.pid,
        happySessionId: 'session-other',
        happyHomeDir: '/tmp/happier-home',
        createdAt: 1,
        updatedAt: 2,
        flavor: 'opencode',
        processCommandHash: 'a'.repeat(64),
        processStartTimeMs: 1_717_171_717_000,
        metadata: {
            flavor: 'opencode',
            opencodeSessionId: 'remote-1',
        },
    }]);
}

const failClosedPersistedTakeoverServerSnapshots: ReadonlyArray<
    readonly [string, () => CliServerFeaturesSnapshot | undefined]
> = [
    ['hosted-admission fence v1', () => readyServerFeatures(1)],
    ['pre-runtime-bound admission fence v2', () => readyServerFeatures(2)],
    ['missing server snapshot', () => undefined],
    ['malformed hosted-admission fence', () => ({
        status: 'ready',
        features: {
            capabilities: {
                session: {
                    externalImport: {
                        publicationFenceVersion: '2',
                    },
                },
            },
        },
    } as unknown as CliServerFeaturesSnapshot)],
];

describe('executeExternalSessionStatusGetAction observation reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listSessionMarkers.mockResolvedValue([]);
        mocks.verifyProcessLiveness.mockResolvedValue({
            status: 'verified_stopped',
            pid: process.pid,
            processStartTimeMs: 1_717_171_717_000,
        });
        mocks.validateExternalMachineSource.mockResolvedValue({
            ok: true,
            source: request.source,
        });
        mocks.resolveSource.mockImplementation(async (sourceRequest) => ({
            ok: true,
            value: { source: sourceRequest.source },
        }));
        mocks.readCredentials.mockResolvedValue({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
        });
        mocks.loadLinkedExternalSession.mockResolvedValue({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                linkGeneration: '1000',
                source: request.source,
                canonicalResolvedSourceKey: 'opencodeServer:::',
                metadata: {
                    externalSessionV1: {
                        v: 1,
                        agentId: 'opencode',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: request.source,
                        qualifiedIdentity: qualifiedLinkIdentity,
                        linkData: { endpoint: 'default' },
                        linkedAtMs: 1_000,
                    },
                },
            },
        });
        mocks.isExternalTakeoverLaunchAvailable.mockResolvedValue(true);
        mocks.resolveExternalLinkedTakeoverWriterSafety.mockResolvedValue(
            'native_prevention',
        );
        mocks.resolveLinkedIdentity.mockResolvedValue({
            ok: true,
            value: {
                source: request.source,
                remoteSessionId: 'remote-1',
                linkData: { endpoint: 'default' },
            },
        });
        mocks.acquireRuntimeRegistryLease.mockResolvedValue({
            registry: {
                contributes: {
                    agentDefinitionsById: new Map([[
                        'opencode',
                        {
                            id: 'opencode',
                            pluginId: 'happier.opencode',
                            identity: qualifiedLinkIdentity.agent,
                            richDefinition: {
                                definition: {
                                    surfaces: {
                                        externalSession: {
                                            sources: [{
                                                sourceKind: 'opencodeServer',
                                                schema: {
                                                    fields: [
                                                        {
                                                            name: 'kind',
                                                            kind: 'literal',
                                                            value: 'opencodeServer',
                                                        },
                                                        {
                                                            name: 'directory',
                                                            kind: 'string',
                                                            optional: true,
                                                            nullish: true,
                                                        },
                                                    ],
                                                },
                                                key: {
                                                    segments: [
                                                        {
                                                            kind: 'literal',
                                                            value: 'opencodeServer',
                                                        },
                                                        {
                                                            kind: 'field',
                                                            field: 'directory',
                                                        },
                                                    ],
                                                },
                                            }],
                                        },
                                    },
                                },
                            },
                        },
                    ]]),
                },
                activateContributionsOnDemand: vi.fn(async () => []),
                agentRuntimesByAgentId: new Map([[
                    'opencode',
                    {
                        pluginId: 'happier.opencode',
                        agentId: 'opencode',
                        generation: 'plugin-generation-1',
                        isCurrent: () => true,
                        externalSessions: {
                            resolveSource: mocks.resolveSource,
                            resolveLinkedIdentity: mocks.resolveLinkedIdentity,
                            pageTranscript: vi.fn(),
                            readAfterTranscript: vi.fn(),
                        },
                        externalSessionObservation: {
                            describeResource: mocks.describeResource,
                        },
                    },
                ]]),
            },
            release: vi.fn(async () => {}),
        });
        mocks.describeResource.mockReturnValue({
            resourceKey: 'endpoint-default',
            linkKey: 'remote-1',
        });
    });

    it('admits the exact validated request identity before status or takeover effects', async () => {
        mocks.loadLinkedExternalSession.mockResolvedValueOnce({
            ok: false,
            errorCode: 'invalid_request',
            error: 'linked_session_identity_mismatch',
        });
        const owner = actionContext(snapshot('working'));

        const response = await executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        );

        expect(mocks.loadLinkedExternalSession).toHaveBeenCalledWith({
            credentials: expect.any(Object),
            sessionId: request.sessionId,
            machineId: request.machineId,
            expectedIdentity: {
                agentId: request.agentId,
                machineId: request.machineId,
                remoteSessionId: request.remoteSessionId,
                source: request.source,
            },
        });
        expect(response).toMatchObject({
            ok: true,
            activity: 'unknown',
            externalAgent: null,
            canTakeOverDirect: false,
            canTakeOverPersist: false,
        });
        expect(mocks.validateExternalMachineSource).not.toHaveBeenCalled();
        expect(owner.reconcileStatusLink).not.toHaveBeenCalled();
        expect(mocks.listSessionMarkers).not.toHaveBeenCalled();
        expect(mocks.isExternalTakeoverLaunchAvailable).not.toHaveBeenCalled();
        expect(mocks.resolveExternalLinkedTakeoverWriterSafety).not.toHaveBeenCalled();
    });

    it('fails closed before status or takeover effects when the persisted source is no longer configured', async () => {
        mocks.validateExternalMachineSource.mockResolvedValueOnce({
            ok: false,
            errorCode: 'invalid_request',
            error: 'external_session_source_invalid',
        });
        const owner = actionContext(snapshot('working'));

        await expect(executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        )).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_request',
            error: 'external_session_source_invalid',
        });

        expect(mocks.validateExternalMachineSource).toHaveBeenCalledWith({
            agentId: 'opencode',
            source: request.source,
            env: process.env,
        });
        expect(owner.reconcileStatusLink).not.toHaveBeenCalled();
        expect(mocks.resolveSource).not.toHaveBeenCalled();
        expect(mocks.listSessionMarkers).not.toHaveBeenCalled();
        expect(mocks.isExternalTakeoverLaunchAvailable).not.toHaveBeenCalled();
        expect(mocks.resolveExternalLinkedTakeoverWriterSafety).not.toHaveBeenCalled();
    });

    it('does not expose an unknown marker PID as trusted or takeover-safe', async () => {
        mocks.listSessionMarkers.mockResolvedValue([{
            pid: process.pid,
            happySessionId: 'session-other',
            happyHomeDir: '/tmp/happier-home',
            createdAt: 1,
            updatedAt: 2,
            flavor: 'opencode',
            processCommandHash: 'a'.repeat(64),
            processStartTimeMs: 1_717_171_717_000,
            metadata: {
                flavor: 'opencode',
                opencodeSessionId: 'remote-1',
            },
        }]);
        mocks.verifyProcessLiveness.mockResolvedValue({
            status: 'unknown',
            pid: process.pid,
            processStartTimeMs: 1_717_171_717_000,
        });
        const { context } = actionContext(snapshot('unknown'));

        const response = await executeExternalSessionStatusGetAction(request, context as never);

        expect(response).toMatchObject({
            ok: true,
            runnerActive: false,
            canTakeOverDirect: false,
            canTakeOverPersist: false,
            canForceStop: false,
            trustedPid: null,
        });
    });

    it('reports an exactly verified running owner without offering a force bypass', async () => {
        mocks.listSessionMarkers.mockResolvedValue([{
            pid: process.pid,
            happySessionId: 'session-other',
            happyHomeDir: '/tmp/happier-home',
            createdAt: 1,
            updatedAt: 2,
            flavor: 'opencode',
            processCommandHash: 'a'.repeat(64),
            processStartTimeMs: 1_717_171_717_000,
            metadata: {
                flavor: 'opencode',
                opencodeSessionId: 'remote-1',
            },
        }]);
        mocks.verifyProcessLiveness.mockResolvedValue({
            status: 'verified_running',
            pid: process.pid,
            processStartTimeMs: 1_717_171_717_000,
        });
        const { context } = actionContext(snapshot('unknown'));

        const response = await executeExternalSessionStatusGetAction(request, context as never);

        expect(response).toMatchObject({
            ok: true,
            runnerActive: true,
            canTakeOverDirect: false,
            canTakeOverPersist: false,
            canForceStop: false,
            trustedPid: process.pid,
        });
    });

    it('offers direct takeover only for exact verified-stopped protocol evidence', async () => {
        setVerifiedStoppedOwnerMarker();
        const { context } = actionContext(snapshot('unknown'));

        const response = await executeExternalSessionStatusGetAction(request, context as never);

        expect(response).toMatchObject({
            ok: true,
            runnerActive: false,
            canTakeOverDirect: true,
            canTakeOverPersist: true,
            canForceStop: false,
            trustedPid: null,
        });
    });

    it('does not advertise external-linked takeover without writer safety while keeping persisted takeover independently truthful', async () => {
        setVerifiedStoppedOwnerMarker();
        mocks.resolveExternalLinkedTakeoverWriterSafety.mockResolvedValue(
            'unsupported',
        );
        const { context } = actionContext(snapshot('unknown'));

        const response = await executeExternalSessionStatusGetAction(
            request,
            context as never,
        );

        expect(
            mocks.resolveExternalLinkedTakeoverWriterSafety,
        ).toHaveBeenCalledWith('opencode');
        expect(response).toMatchObject({
            ok: true,
            runnerActive: false,
            canTakeOverDirect: false,
            canTakeOverPersist: true,
            canForceStop: false,
            trustedPid: null,
        });
    });

    it('fails direct takeover availability closed when writer-safety resolution fails', async () => {
        setVerifiedStoppedOwnerMarker();
        mocks.resolveExternalLinkedTakeoverWriterSafety.mockRejectedValue(
            new Error('projection unavailable'),
        );
        const { context } = actionContext(snapshot('unknown'));

        const response = await executeExternalSessionStatusGetAction(
            request,
            context as never,
        );

        expect(response).toMatchObject({
            ok: true,
            runnerActive: false,
            canTakeOverDirect: false,
            canTakeOverPersist: true,
            canForceStop: false,
            trustedPid: null,
        });
    });

    it.each(failClosedPersistedTakeoverServerSnapshots)(
        'keeps persisted takeover unavailable for %s without changing direct takeover',
        async (
            _label,
            readSnapshot,
        ) => {
            setVerifiedStoppedOwnerMarker();
            const getServerFeaturesSnapshot = vi.fn(readSnapshot);
            const { context } = actionContext(
                snapshot('unknown'),
                getServerFeaturesSnapshot,
            );

            const response = await executeExternalSessionStatusGetAction(
                request,
                context as never,
            );

            expect(response).toMatchObject({
                ok: true,
                canTakeOverDirect: true,
                canTakeOverPersist: false,
            });
            expect(getServerFeaturesSnapshot).toHaveBeenCalledOnce();
        },
    );

    it('offers persisted takeover when runtime-bound fence v3 and all existing safety facts admit it', async () => {
        setVerifiedStoppedOwnerMarker();
        const getServerFeaturesSnapshot = vi.fn(() => readyServerFeatures(
            EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
        ));
        const { context } = actionContext(
            snapshot('unknown'),
            getServerFeaturesSnapshot,
        );

        const response = await executeExternalSessionStatusGetAction(
            request,
            context as never,
        );

        expect(response).toMatchObject({
            ok: true,
            canTakeOverDirect: true,
            canTakeOverPersist: true,
        });
        expect(getServerFeaturesSnapshot).toHaveBeenCalledOnce();
    });

    it('asks the canonical takeover availability owner for the current linked Agent', async () => {
        const owner = actionContext(snapshot('unknown'));
        mocks.isExternalTakeoverLaunchAvailable.mockResolvedValueOnce(false);
        const loaded = await mocks.loadLinkedExternalSession();
        mocks.loadLinkedExternalSession.mockResolvedValueOnce({
            ...loaded,
            session: {
                ...loaded.session,
                linkGeneration: '2000',
                linkData: { endpoint: 'replacement' },
                metadata: {
                    externalSessionV1: {
                        ...loaded.session.metadata.externalSessionV1,
                        linkedAtMs: 2_000,
                        linkData: { endpoint: 'replacement' },
                    },
                },
            },
        });

        const response = await executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        );

        expect(mocks.isExternalTakeoverLaunchAvailable)
            .toHaveBeenCalledWith('opencode');
        expect(response).toMatchObject({
            ok: true,
            canTakeOverPersist: false,
        });
    });

    it.each([
        ['working', 'running'],
        ['recentlyActive', 'active_recently'],
        ['idle', 'idle'],
        ['waiting', 'unknown'],
        ['retrying', 'unknown'],
        ['unknown', 'unknown'],
    ] as const)('returns canonical %s and maps legacy activity conservatively', async (
        status,
        activity,
    ) => {
        const owner = actionContext(snapshot(status));

        const response = await executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        );

        expect(mocks.acquireRuntimeRegistryLease).toHaveBeenCalledOnce();
        expect(mocks.resolveLinkedIdentity).toHaveBeenCalledOnce();
        expect(mocks.describeResource).toHaveBeenCalledOnce();
        expect(response).toMatchObject({
            ok: true,
            activity,
            externalAgent: snapshot(status),
        });
        if (status === 'recentlyActive') {
            expect(response).toMatchObject({ lastKnownActivityAtMs: 1_000 });
        } else {
            expect(response).not.toHaveProperty('lastKnownActivityAtMs');
        }
    });

    it('reconciles the current qualified link once without legacy activity, transcript, or metadata work', async () => {
        const owner = actionContext(snapshot('working'));
        const response = await executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        );

        expect(response).toMatchObject({
            ok: true,
            activity: 'running',
            externalAgent: snapshot('working'),
        });
        expect(owner.reconcileStatusLink).toHaveBeenCalledTimes(1);
        expect(owner.reconcileStatusLink).toHaveBeenCalledWith({
            resource: {
                pluginId: 'happier.opencode',
                agentLocalId: 'opencode',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'endpoint-default',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: '1000',
                linkKey: 'remote-1',
                linkedSource: {
                    source: request.source,
                    remoteSessionId: 'remote-1',
                    linkData: { endpoint: 'default' },
                },
            },
            target: {
                qualifiedLinkIdentity,
                linkGeneration: '1000',
            },
        });
        expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
        const runtime = (
            await mocks.acquireRuntimeRegistryLease.mock.results[0]!.value
        ).registry.agentRuntimesByAgentId.get('opencode');
        expect(runtime.externalSessions.pageTranscript).not.toHaveBeenCalled();
        expect(runtime.externalSessions.readAfterTranscript).not.toHaveBeenCalled();
    });

    it('returns explicit canonical absence when no current observation facet is available', async () => {
        const lease = await mocks.acquireRuntimeRegistryLease();
        lease.registry.agentRuntimesByAgentId.set('opencode', {
            ...lease.registry.agentRuntimesByAgentId.get('opencode'),
            externalSessionObservation: undefined,
        });
        mocks.acquireRuntimeRegistryLease.mockResolvedValueOnce(lease);
        const owner = actionContext(snapshot('working'));

        const response = await executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        );

        expect(response).toMatchObject({
            ok: true,
            activity: 'unknown',
            externalAgent: null,
        });
        expect(owner.reconcileStatusLink).not.toHaveBeenCalled();
    });

    it('does not route a persisted link qualified to a different Agent owner', async () => {
        const loaded = await mocks.loadLinkedExternalSession();
        mocks.loadLinkedExternalSession.mockResolvedValueOnce({
            ...loaded,
            session: {
                ...loaded.session,
                metadata: {
                    externalSessionV1: {
                        ...loaded.session.metadata.externalSessionV1,
                        qualifiedIdentity: {
                            ...qualifiedLinkIdentity,
                            agent: {
                                pluginId: 'other.agent',
                                localId: 'opencode',
                            },
                        },
                    },
                },
            },
        });
        const owner = actionContext(snapshot('working'));

        const response = await executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        );

        expect(response).toMatchObject({
            ok: true,
            activity: 'unknown',
            externalAgent: null,
        });
        expect(mocks.resolveLinkedIdentity).not.toHaveBeenCalled();
        expect(mocks.describeResource).not.toHaveBeenCalled();
        expect(owner.reconcileStatusLink).not.toHaveBeenCalled();
    });

    it('releases the registry invocation lease before projection reacquires the exact generation', async () => {
        const owner = actionContext(null);

        const response = await executeExternalSessionStatusGetAction(
            request,
            owner.context as never,
        );

        const runtimeRegistryLease = await mocks.acquireRuntimeRegistryLease.mock.results[0]!.value;
        const releaseOrder = runtimeRegistryLease.release.mock.invocationCallOrder[0];
        const projectionOrder = owner.reconcileStatusLink.mock.invocationCallOrder[0];
        expect(releaseOrder).toBeTypeOf('number');
        expect(projectionOrder).toBeTypeOf('number');
        expect(releaseOrder).toBeLessThan(projectionOrder);
        expect(response).toMatchObject({
            ok: true,
            activity: 'unknown',
            externalAgent: null,
        });
    });
});
