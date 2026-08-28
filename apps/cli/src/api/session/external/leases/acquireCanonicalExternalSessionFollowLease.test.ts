import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const {
    fetchSessionByIdMock,
    fetchAccountEncryptionCurrentnessMock,
    tryDecryptSessionOwnerMetadataViewMock,
    updateSessionMetadataWithRetryMock,
} = vi.hoisted(() => ({
    fetchSessionByIdMock: vi.fn(),
    fetchAccountEncryptionCurrentnessMock: vi.fn(),
    tryDecryptSessionOwnerMetadataViewMock: vi.fn(),
    updateSessionMetadataWithRetryMock: vi.fn(async () => {}),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
    fetchAccountEncryptionCurrentness: fetchAccountEncryptionCurrentnessMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/session/transport/http/sessionsHttp')
    >();
    return {
        ...actual,
        fetchSessionById: fetchSessionByIdMock,
    };
});

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
    tryDecryptSessionOwnerMetadataView: tryDecryptSessionOwnerMetadataViewMock,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
    updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendExecutionSurfaces: async () => ({ externalSession: null }),
}));

import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

import {
    acquireCanonicalExternalSessionFollowLease,
    canAttemptCanonicalExternalSessionLiveFollow,
} from './acquireCanonicalExternalSessionFollowLease';
import type { ExternalSessionObservationLinkInput } from './resolveExternalSessionObservationLinkInput';

const credentials = {
    token: 'token',
    encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array([1]),
    },
};
const source = {
    kind: 'claudeConfig' as const,
    configDir: '/tmp/happier-follow-recovery-claude',
    projectId: 'project-follow-recovery',
};
const rawSession = {
    id: 'session-background-follow',
    metadata: 'encrypted-metadata',
    metadataVersion: 1,
};
const metadata = {
    externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-background-follow',
        remoteSessionId: 'remote-background-follow',
        source,
        linkedAtMs: 1,
    },
};
const resource = {
    linkGeneration: '1',
    pluginGeneration: 'plugin-generation',
};
const observation = {
    resource: {
        pluginId: 'happier.agent.claude',
        agentLocalId: 'claude',
        pluginGeneration: resource.pluginGeneration,
        resourceKey: 'resource-follow-recovery',
    },
    link: {
        sessionId: rawSession.id,
        linkGeneration: resource.linkGeneration,
        linkKey: 'link-follow-recovery',
        linkedSource: {
            source,
            remoteSessionId: 'remote-background-follow',
            linkData: {},
        },
        changeObservation: 'watch_file_changes',
    },
    target: {
        qualifiedLinkIdentity: {
            v: 1,
            agent: {
                pluginId: 'happier.agent.claude',
                localId: 'claude',
            },
            source: {
                kind: 'claudeConfig',
                contractVersion: 1,
            },
        },
        linkGeneration: resource.linkGeneration,
    },
} as ExternalSessionObservationLinkInput;

const transcriptItem = (id: string, createdAtMs: number): ExternalSessionTranscriptRawMessageV1 => ({
    id,
    createdAtMs,
    raw: {},
});

describe('acquireCanonicalExternalSessionFollowLease background recovery', () => {
    let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

    beforeAll(async () => {
        runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
                contributes: getResolvedContributionRegistry(),
                pluginIds: ['happier.agent.claude'],
            }),
        });
    });

    afterAll(async () => {
        await runtimeRegistryLease?.release();
        runtimeRegistryLease = null;
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', source.configDir);
        fetchSessionByIdMock.mockResolvedValue(rawSession);
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        });
        tryDecryptSessionOwnerMetadataViewMock.mockReturnValue(metadata);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    async function acquire(
        readAfterTranscript: NonNullable<
            ExternalSessionExecutionSurface['readAfterTranscript']
        >,
        pageTranscript = vi.fn(async () => ({
            items: [transcriptItem('resynced-item', 20)],
            nextCursor: null,
            tailCursor: 'cursor-resynced',
            hasMore: false,
            truncated: false,
        })),
    ) {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);

        return {
            lease: await acquireCanonicalExternalSessionFollowLease({
                sessionId: rawSession.id,
                machineId: 'machine-background-follow',
                linked: loaded.session,
                resource,
                observation,
                providerOps: {
                    pageTranscript,
                    readAfterTranscript,
                },
                initialCursor: 'cursor-accepted',
                maxBytes: 64_000,
                maxItems: 200,
                observationProjection: {
                    reconcileTranscriptDemand: async () => ({ state: 'observing' }),
                },
                credentials,
            }),
            pageTranscript,
        };
    }

    it('retains the accepted cursor until one bounded authoritative gap resync succeeds', async () => {
        const requestedCursors: string[] = [];
        const readAfterTranscript = vi.fn(async (input: Readonly<{ cursor: string }>) => {
            requestedCursors.push(input.cursor);
            return requestedCursors.length === 1
                ? { outcome: 'gap_or_cursor_expired' as const }
                : { outcome: 'already_current' as const };
        });
        const { lease, pageTranscript } = await acquire(readAfterTranscript);

        expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
        const result = await lease.requestTranscriptRefresh?.();

        expect(result).toMatchObject({ outcome: 'gap_or_cursor_expired' });
        if (!result || result.outcome !== 'gap_or_cursor_expired') {
            throw new Error('Expected a bounded gap recovery');
        }
        expect(pageTranscript).not.toHaveBeenCalled();

        await lease.requestTranscriptRefresh?.();
        expect(requestedCursors).toEqual(['cursor-accepted', 'cursor-accepted']);

        await result.recover();
        expect(pageTranscript).toHaveBeenCalledOnce();
        expect(lease.readAcceptedCursor?.()).toBe('cursor-resynced');
        expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
            direction: 'older',
            maxBytes: 64_000,
            maxItems: 200,
        }));
        expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledOnce();

        await lease.requestTranscriptRefresh?.();
        expect(requestedCursors).toEqual([
            'cursor-accepted',
            'cursor-accepted',
            'cursor-resynced',
        ]);
    });

    it.each([
        {
            label: 'older history remains below the bounded newest page',
            page: { nextCursor: 'older-cursor-1', hasMore: true, truncated: false },
        },
        {
            label: 'the bounded newest page is itself discontinuous',
            page: { nextCursor: null, hasMore: false, truncated: true },
        },
    ])('retains the accepted cursor and requires a resync when $label', async ({ page }) => {
        const readAfterTranscript = vi.fn(async () => ({
            outcome: 'gap_or_cursor_expired' as const,
        }));
        const pageTranscript = vi.fn(async () => ({
            items: [transcriptItem('unaccounted-tail-item', 20)],
            tailCursor: 'cursor-unaccounted-tail',
            ...page,
        }));
        const { lease } = await acquire(readAfterTranscript, pageTranscript);

        expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
        const result = await lease.requestTranscriptRefresh?.();
        if (!result || result.outcome !== 'gap_or_cursor_expired') {
            throw new Error('Expected a bounded gap recovery');
        }

        await expect(result.recover()).resolves.toEqual({ outcome: 'resync_required' });
        expect(pageTranscript).toHaveBeenCalledOnce();
        // The unaccounted tail is never adopted as the accepted cursor.
        expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });

    it('revalidates an exact hosted owner during gap recovery without persisting a second link', async () => {
        const hostedSource = {
            kind: 'codexHome' as const,
            home: 'user' as const,
        };
        const hostedRawSession = {
            id: 'session-hosted-follow',
            currentStorageState: 'hosted' as const,
            metadata: 'encrypted-hosted-metadata',
            metadataVersion: 1,
        };
        const hostedMetadata = {
            machineId: 'machine-hosted-follow',
            flavor: 'codex',
            codexSessionId: 'thread-hosted-follow',
        };
        fetchSessionByIdMock.mockResolvedValue(hostedRawSession);
        tryDecryptSessionOwnerMetadataViewMock.mockReturnValue(hostedMetadata);

        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: hostedRawSession.id,
            machineId: 'machine-hosted-follow',
            expectedIdentity: {
                agentId: 'codex',
                machineId: 'machine-hosted-follow',
                remoteSessionId: 'thread-hosted-follow',
                source: hostedSource,
            },
        });
        if (!loaded.ok) throw new Error(loaded.error);

        const hostedResource = {
            linkGeneration: loaded.session.linkGeneration,
            pluginGeneration: 'plugin-generation-hosted',
        };
        const hostedObservation: ExternalSessionObservationLinkInput = {
            ...observation,
            resource: {
                ...observation.resource,
                pluginId: 'happier.agent.codex',
                agentLocalId: 'codex',
                pluginGeneration: hostedResource.pluginGeneration,
            },
            link: {
                ...observation.link,
                sessionId: hostedRawSession.id,
                linkGeneration: hostedResource.linkGeneration,
                linkedSource: {
                    source: hostedSource,
                    remoteSessionId: 'thread-hosted-follow',
                    linkData: {},
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
                linkGeneration: hostedResource.linkGeneration,
            },
        };
        const pageTranscript = vi.fn(async () => ({
            items: [transcriptItem('hosted-resync-item', 20)],
            nextCursor: null,
            tailCursor: 'cursor-hosted-resynced',
            hasMore: false,
            truncated: false,
        }));
        const lease = await acquireCanonicalExternalSessionFollowLease({
            sessionId: hostedRawSession.id,
            machineId: 'machine-hosted-follow',
            linked: loaded.session,
            resource: hostedResource,
            observation: hostedObservation,
            providerOps: {
                pageTranscript,
                readAfterTranscript: async () => ({
                    outcome: 'gap_or_cursor_expired',
                }),
            },
            initialCursor: 'cursor-hosted-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async () => ({ state: 'observing' }),
            },
            credentials,
        });

        const result = await lease.requestTranscriptRefresh?.();
        expect(result).toMatchObject({ outcome: 'gap_or_cursor_expired' });
        if (!result || result.outcome !== 'gap_or_cursor_expired') {
            throw new Error('Expected hosted bounded gap recovery');
        }
        await expect(result.recover()).resolves.toBeUndefined();
        expect(pageTranscript).toHaveBeenCalledOnce();
    });

    it.each([
        'source_replaced',
        'source_unavailable',
        'read_failed',
    ] as const)(
        'retains prior accepted authority and reports %s without tail jumping',
        async (outcome) => {
            const requestedCursors: string[] = [];
            const readAfterTranscript = vi.fn(async (input: Readonly<{ cursor: string }>) => {
                requestedCursors.push(input.cursor);
                return { outcome };
            });
            const { lease, pageTranscript } = await acquire(readAfterTranscript);

            await expect(lease.requestTranscriptRefresh?.()).resolves.toEqual({ outcome });
            await expect(lease.requestTranscriptRefresh?.()).resolves.toEqual({ outcome });

            expect(requestedCursors).toEqual(['cursor-accepted', 'cursor-accepted']);
            expect(pageTranscript).not.toHaveBeenCalled();
            expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
        },
    );

    it('retains prior accepted authority when progress publication rejects', async () => {
        const requestedCursors: string[] = [];
        const readAfterTranscript = vi.fn(async (input: Readonly<{ cursor: string }>) => {
            requestedCursors.push(input.cursor);
            return {
                outcome: 'advanced' as const,
                items: [transcriptItem('advanced-item', 30)],
                nextCursor: 'cursor-advanced',
                boundary: 'boundary-advanced',
                hasMore: false,
            };
        });
        updateSessionMetadataWithRetryMock
            .mockRejectedValueOnce(new Error('progress publication rejected'))
            .mockResolvedValue(undefined);
        const { lease } = await acquire(readAfterTranscript);

        await expect(lease.requestTranscriptRefresh?.())
            .rejects.toThrow('progress publication rejected');
        await expect(lease.requestTranscriptRefresh?.())
            .resolves.toEqual({ outcome: 'advanced' });

        expect(requestedCursors).toEqual(['cursor-accepted', 'cursor-accepted']);
    });

    it('does not complete release or advance the accepted cursor while progress publication is in flight', async () => {
        let releaseProgressPublication!: () => void;
        const progressPublication = new Promise<void>((resolve) => {
            releaseProgressPublication = resolve;
        });
        updateSessionMetadataWithRetryMock.mockImplementationOnce(
            async () => await progressPublication,
        );
        const demanded: boolean[] = [];
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const lease = await acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource,
            observation,
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: async () => ({
                    outcome: 'advanced' as const,
                    items: [transcriptItem('advanced-during-release', 31)],
                    nextCursor: 'cursor-must-not-commit',
                    boundary: 'boundary-during-release',
                    hasMore: false,
                }),
            },
            initialCursor: 'cursor-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async (input) => {
                    demanded.push(input.demanded);
                    return {
                        state: input.demanded ? 'observing' : 'not-demanded',
                    };
                },
            },
            credentials,
        });
        const completions: string[] = [];
        const refresh = lease.requestTranscriptRefresh?.().then(() => {
            completions.push('refresh');
        });
        await vi.waitFor(() => {
            expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledOnce();
        });

        const release = lease.release().then(() => {
            completions.push('release');
        });
        const duplicateRelease = lease.release().then(() => {
            completions.push('duplicate-release');
        });
        await vi.waitFor(() => {
            expect(demanded).toEqual([true, false]);
        });
        await Promise.resolve();
        expect(completions).toEqual([]);

        releaseProgressPublication();
        await Promise.all([refresh, release, duplicateRelease]);
        expect(completions).toEqual([
            'refresh',
            'release',
            'duplicate-release',
        ]);
        expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
    });

    it('does not commit an advanced cursor when release starts during final link validation', async () => {
        let fetchCount = 0;
        let releaseFinalValidation!: () => void;
        const finalValidation = new Promise<void>((resolve) => {
            releaseFinalValidation = resolve;
        });
        fetchSessionByIdMock.mockImplementation(async () => {
            fetchCount += 1;
            if (fetchCount === 6) {
                await finalValidation;
            }
            return rawSession;
        });
        const demanded: boolean[] = [];
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const lease = await acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource,
            observation,
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: async () => ({
                    outcome: 'advanced' as const,
                    items: [transcriptItem('advanced-before-final-validation', 32)],
                    nextCursor: 'cursor-must-not-commit',
                    boundary: 'boundary-before-final-validation',
                    hasMore: false,
                }),
            },
            initialCursor: 'cursor-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async (input) => {
                    demanded.push(input.demanded);
                    return {
                        state: input.demanded ? 'observing' : 'not-demanded',
                    };
                },
            },
            credentials,
        });

        const refresh = lease.requestTranscriptRefresh?.();
        await vi.waitFor(() => {
            expect(fetchCount).toBe(6);
        });
        let releaseCompleted = false;
        const release = lease.release().then(() => {
            releaseCompleted = true;
        });
        await vi.waitFor(() => {
            expect(demanded).toEqual([true, false]);
        });
        await Promise.resolve();
        expect(releaseCompleted).toBe(false);

        releaseFinalValidation();
        await Promise.all([refresh, release]);

        expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
        expect(demanded).toEqual([true, false]);
        expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledOnce();
    });

    it('releases transcript demand when canonical observer admission is unavailable', async () => {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const demanded: boolean[] = [];

        await expect(acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource,
            observation,
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            initialCursor: 'cursor-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async (input) => {
                    demanded.push(input.demanded);
                    return input.demanded
                        ? { state: 'reconcile-only' }
                        : { state: 'not-demanded' };
                },
            },
            credentials,
        })).rejects.toMatchObject({
            name: 'ExternalSessionFollowFailureError',
            kind: 'follow_unavailable',
            message: 'External Session live follow is unavailable: reconcile-only',
        });

        expect(demanded).toEqual([true, false]);
    });

    it('rejects a same-kind relink before creating transcript demand or reading content', async () => {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const reconcileTranscriptDemand = vi.fn();
        const pageTranscript = vi.fn();
        const readAfterTranscript = vi.fn();

        await expect(acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: {
                ...loaded.session,
                source: {
                    ...loaded.session.source,
                    configDir: '/tmp/relinked-claude-config',
                },
            },
            resource,
            observation,
            providerOps: { pageTranscript, readAfterTranscript },
            initialCursor: 'cursor-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: { reconcileTranscriptDemand },
            credentials,
        })).rejects.toMatchObject({
            name: 'ExternalSessionFollowFailureError',
            kind: 'source_changed',
            message: 'External Session link changed before follow acquisition',
        });

        expect(reconcileTranscriptDemand).not.toHaveBeenCalled();
        expect(pageTranscript).not.toHaveBeenCalled();
        expect(readAfterTranscript).not.toHaveBeenCalled();
    });

    it('does not read a baseline after generation retirement during observer admission', async () => {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const retirement = new AbortController();
        const demanded: boolean[] = [];
        let completeAdmission!: () => void;
        const admission = new Promise<void>((resolve) => {
            completeAdmission = resolve;
        });
        const pageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'cursor-must-not-be-read',
            hasMore: false,
            truncated: false,
        }));

        const acquisition = acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource: {
                ...resource,
                retirementSignal: retirement.signal,
            },
            observation,
            providerOps: {
                pageTranscript,
                readAfterTranscript: vi.fn(),
            },
            initialCursor: null,
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async (input) => {
                    demanded.push(input.demanded);
                    if (input.demanded) {
                        await admission;
                        return { state: 'observing' };
                    }
                    return { state: 'not-demanded' };
                },
            },
            credentials,
        });
        await vi.waitFor(() => {
            expect(demanded).toEqual([true]);
        });

        retirement.abort();
        completeAdmission();

        await expect(acquisition).rejects.toMatchObject({
            name: 'ExternalSessionFollowFailureError',
            kind: 'source_changed',
            message: 'External Session follow generation retired during acquisition',
        });
        expect(pageTranscript).not.toHaveBeenCalled();
        expect(demanded).toEqual([true, false]);
    });

    it('releases transcript demand once and preserves an admission rejection', async () => {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const demanded: boolean[] = [];
        const admissionError = new Error('descriptor admission rejected');

        const rejected = acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource,
            observation,
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            initialCursor: 'cursor-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async (input) => {
                    demanded.push(input.demanded);
                    if (input.demanded) throw admissionError;
                    return { state: 'not-demanded' };
                },
            },
            credentials,
        });

        await expect(rejected).rejects.toBe(admissionError);
        expect(demanded).toEqual([true, false]);
    });

    it('releases an admitted transcript demand idempotently', async () => {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const demanded: boolean[] = [];
        const pageTranscript = vi.fn();
        const readAfterTranscript = vi.fn();
        const lease = await acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource,
            observation,
            providerOps: {
                pageTranscript,
                readAfterTranscript,
            },
            initialCursor: 'cursor-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async (input) => {
                    demanded.push(input.demanded);
                    return {
                        state: input.demanded ? 'observing' : 'not-demanded',
                    };
                },
            },
            credentials,
        });

        await lease.release();
        await lease.release();
        await lease.requestTranscriptRefresh?.();
        expect(demanded).toEqual([true, false]);
        expect(pageTranscript).not.toHaveBeenCalled();
        expect(readAfterTranscript).not.toHaveBeenCalled();
    });

    it('keeps release custody when transcript-demand cleanup rejects until the exact retry succeeds', async () => {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const cleanupFailure = new Error('transcript demand cleanup rejected');
        const demanded: boolean[] = [];
        const reconcileTranscriptDemand = vi.fn(async (input: Readonly<{
            demanded: boolean;
        }>) => {
            demanded.push(input.demanded);
            if (!input.demanded && demanded.filter((value) => !value).length === 1) {
                throw cleanupFailure;
            }
            return { state: input.demanded ? 'observing' : 'not-demanded' };
        });
        const lease = await acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource,
            observation,
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
            initialCursor: 'cursor-accepted',
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: { reconcileTranscriptDemand },
            credentials,
        });

        await expect(lease.release()).rejects.toBe(cleanupFailure);
        await expect(lease.release()).resolves.toBeUndefined();

        expect(demanded).toEqual([true, false, false]);
    });

    it('allows grouping-only links to enter canonical descriptor admission', () => {
        expect(canAttemptCanonicalExternalSessionLiveFollow({
            observation: {
                ...observation,
                link: {
                    ...observation.link,
                    changeObservation: undefined,
                },
            },
            resource,
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
        })).toBe(true);
        expect(canAttemptCanonicalExternalSessionLiveFollow({
            observation: {
                ...observation,
                link: {
                    ...observation.link,
                    changeObservation: 'reconcile_only',
                },
            },
            resource,
            providerOps: {
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            },
        })).toBe(false);
    });
});
