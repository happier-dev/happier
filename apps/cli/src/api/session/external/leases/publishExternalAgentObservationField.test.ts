import { describe, expect, it, vi } from 'vitest';
import {
    buildLinkedExternalSessionMetadataV1,
    type ExternalAgentObservationSnapshotV1,
    type LinkedExternalSessionQualifiedIdentityV1,
    type SessionMetadata,
} from '@happier-dev/protocol';

import {
    createExternalAgentObservationFieldPublisher,
} from './publishExternalAgentObservationField';

function snapshot(
    boundary?: Readonly<{ id: string; observedAtMs: number }>,
): ExternalAgentObservationSnapshotV1 {
    return {
        v: 1,
        qualifiedLinkIdentity: {
            v: 1,
            agent: {
                pluginId: 'happier.agent.opencode',
                localId: 'opencode',
            },
            source: {
                kind: 'opencodeServer',
                contractVersion: 1,
            },
        },
        linkGeneration: '1000',
        status: 'idle',
        observedAtMs: 2_000,
        expiresAtMs: 3_000,
        ...(boundary ? { boundary } : {}),
    };
}

const QUALIFIED_LINK_IDENTITY = snapshot().qualifiedLinkIdentity;

function linkedMetadata(input?: Readonly<{
    linkedAtMs?: number;
    qualifiedIdentity?: LinkedExternalSessionQualifiedIdentityV1;
}>): SessionMetadata {
    const qualifiedIdentity =
        input?.qualifiedIdentity ?? QUALIFIED_LINK_IDENTITY;
    const isClaude =
        qualifiedIdentity.source.kind === 'claudeConfig';
    return buildLinkedExternalSessionMetadataV1(
        {
            summary: { text: 'External review' },
            preservedMetadata: 'preserved',
        },
        {
            v: 1,
            agentId: isClaude ? 'claude' : 'opencode',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: isClaude
                ? {
                    kind: 'claudeConfig',
                    configDir: '/tmp/claude',
                }
                : {
                    kind: 'opencodeServer',
                    directory: null,
                },
            qualifiedIdentity,
            linkedAtMs: input?.linkedAtMs ?? 1_000,
        },
    ) as SessionMetadata;
}

function setup(params?: Readonly<{
    shouldSendReadyNotification?: () => boolean;
    dispatchReadyNotification?: (input: Readonly<{
        sessionId: string;
        sessionTitle: string | null;
        boundaryId: string;
    }>) => Promise<void>;
    relinkedMetadataOnRetry?: SessionMetadata;
}>) {
    let metadata = linkedMetadata();
    let metadataWriteCount = 0;
    const dispatchReadyNotification = vi.fn(
        params?.dispatchReadyNotification ?? (async () => {}),
    );
    const updateMetadataForTarget = vi.fn(async (input: Readonly<{
        idOrPrefix: string;
        updater(metadata: SessionMetadata): SessionMetadata | Promise<SessionMetadata>;
    }>) => {
        const firstAttempt = await input.updater(metadata);
        if (params?.relinkedMetadataOnRetry) {
            metadata = params.relinkedMetadataOnRetry;
            metadata = await input.updater(metadata);
        } else {
            metadata = firstAttempt;
        }
        metadataWriteCount += 1;
        return {
            ok: true as const,
            sessionId: input.idOrPrefix,
            metadata,
            version: 1,
        };
    });
    const createPublisher = () => createExternalAgentObservationFieldPublisher({
        shouldSendReadyNotification:
            params?.shouldSendReadyNotification ?? (() => true),
        readCredentials: async () => ({ token: 'token' } as never),
        updateMetadataForTarget: updateMetadataForTarget as never,
        dispatchReadyNotification,
    });
    return {
        createPublisher,
        dispatchReadyNotification,
        readMetadataWriteCount: () => metadataWriteCount,
        readMetadata: () => metadata,
        replaceMetadata: (next: SessionMetadata) => {
            metadata = next;
        },
    };
}

describe('publishExternalAgentObservationField', () => {
    it('uses the canonical boundary advancement to suppress replay after restart', async () => {
        const owner = setup();

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        });
        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_500 }),
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
        expect(owner.dispatchReadyNotification).toHaveBeenCalledWith({
            sessionId: 'session-1',
            sessionTitle: 'External review',
            boundaryId: 'boundary-1',
        });
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                boundary: {
                    id: 'boundary-1',
                    observedAtMs: 2_000,
                },
            },
        });
    });

    it('does not retry an attempted boundary after dispatch failure and restart', async () => {
        const owner = setup({
            dispatchReadyNotification: async () => {
                throw new Error('notification transport failed');
            },
        });

        await expect(owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        })).resolves.toBeUndefined();
        await expect(owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        })).resolves.toBeUndefined();

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
    });

    it('publishes markerless mid-turn activity without notification', async () => {
        const owner = setup();

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                ...snapshot(),
                status: 'working',
            },
        });

        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                status: 'working',
            },
        });
        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
    });

    it('does not let a markerless update erase replay protection', async () => {
        const owner = setup();

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        });
        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                ...snapshot(),
                status: 'working',
            },
        });
        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_500 }),
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                status: 'idle',
                boundary: {
                    id: 'boundary-1',
                    observedAtMs: 2_000,
                },
            },
        });
    });

    it('advances a viewed boundary without notifying and does not notify its later replay', async () => {
        let viewerAttached = true;
        const owner = setup({
            shouldSendReadyNotification: () => !viewerAttached,
        });
        const publisher = owner.createPublisher();

        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-viewed', observedAtMs: 2_000 }),
        });
        viewerAttached = false;
        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-viewed', observedAtMs: 2_000 }),
        });

        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
    });

    it('scopes boundary replay suppression to the qualified link generation', async () => {
        const owner = setup();
        const publisher = owner.createPublisher();

        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        });
        owner.replaceMetadata({
            ...linkedMetadata({ linkedAtMs: 2_000 }),
            externalAgentObservationV1:
                owner.readMetadata().externalAgentObservationV1,
        });
        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                ...snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
                linkGeneration: '2000',
            },
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(2);
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                linkGeneration: '2000',
                boundary: {
                    id: 'boundary-1',
                    observedAtMs: 2_000,
                },
            },
        });
    });

    it('drops a stale observation when a metadata retry sees a concurrent relink', async () => {
        const relinkedMetadata = linkedMetadata({
            linkedAtMs: 2_000,
        });
        const owner = setup({ relinkedMetadataOnRetry: relinkedMetadata });

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-stale', observedAtMs: 2_000 }),
        });

        expect(owner.readMetadata()).toEqual(relinkedMetadata);
        expect(owner.readMetadata()).not.toHaveProperty(
            'externalAgentObservationV1',
        );
        expect(owner.readMetadata()).toMatchObject({
            preservedMetadata: 'preserved',
            externalSessionV1: {
                linkedAtMs: 2_000,
                qualifiedIdentity: QUALIFIED_LINK_IDENTITY,
            },
        });
        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
        expect(owner.readMetadataWriteCount()).toBe(0);
    });

    it('drops a stale observation when durable qualified identity no longer matches', async () => {
        const relinkedMetadata = linkedMetadata({
            linkedAtMs: 1_000,
            qualifiedIdentity: {
                ...QUALIFIED_LINK_IDENTITY,
                agent: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude',
                },
                source: {
                    kind: 'claudeConfig',
                    contractVersion: 1,
                },
            },
        });
        const owner = setup({ relinkedMetadataOnRetry: relinkedMetadata });

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot(),
        });

        expect(owner.readMetadata()).toEqual(relinkedMetadata);
        expect(owner.readMetadata()).not.toHaveProperty(
            'externalAgentObservationV1',
        );
        expect(owner.readMetadata()).toMatchObject({
            preservedMetadata: 'preserved',
            externalSessionV1: {
                linkedAtMs: 1_000,
                qualifiedIdentity: {
                    agent: {
                        pluginId: 'happier.agent.claude',
                        localId: 'claude',
                    },
                    source: {
                        kind: 'claudeConfig',
                    },
                },
            },
        });
        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
        expect(owner.readMetadataWriteCount()).toBe(0);
    });

    it('preserves a newer canonical boundary against stale publication', async () => {
        const owner = setup();
        const publisher = owner.createPublisher();

        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-new', observedAtMs: 3_000 }),
        });
        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-old', observedAtMs: 2_000 }),
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                boundary: {
                    id: 'boundary-new',
                    observedAtMs: 3_000,
                },
            },
        });
    });
});
