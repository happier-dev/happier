import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify, { type FastifyInstance } from 'fastify';
import type { MockInstance } from 'vitest';

import {
    readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
    SessionMetadataTuplePatchV1Schema,
    SessionCurrentProjectionRecordV1Schema,
    SessionMetadataVersionConflictV1Schema,
    type ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import {
    createAccountEncryptionCurrentnessFixture,
    createSessionNotificationContextFixture,
} from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withTempDir } from '@/testkit/fs/tempDir';

import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

import {
    acquireCanonicalExternalSessionFollowLease,
    canAttemptCanonicalExternalSessionLiveFollow,
} from './acquireCanonicalExternalSessionFollowLease';
import type { ExternalSessionObservationLinkInput } from './resolveExternalSessionObservationLinkInput';

const credentials = {
    token: 'token',
    encryption: null,
};
const source = {
    kind: 'claudeConfig' as const,
    configDir: '/tmp/happier-follow-recovery-claude',
    projectId: 'project-follow-recovery',
};
const metadata = {
    externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-background-follow',
        remoteSessionId: 'remote-background-follow',
        source,
        linkData: { projectId: source.projectId },
        linkedAtMs: 1,
    },
};
function createStoredSessionRecord(sessionId: string, ownerMetadata: unknown) {
    const fields = buildSessionMetadataEnvelopeFields({
        credentials,
        accountEncryptionMode: 'plain',
        storedContentMode: 'plain',
        metadata: ownerMetadata,
        agentState: null,
    });
    return SessionCurrentProjectionRecordV1Schema.parse({
        ...createSessionNotificationContextFixture(sessionId),
        encryptionMode: 'plain' as const,
        metadataLayoutVersion: fields.metadataLayoutVersion,
        metadata: fields.sharedMetadata.ciphertext,
        ownerMetadata: fields.ownerMetadata,
        share: null,
        agentState: fields.agentState,
        agentStateVersion: 0,
    });
}
const rawSession = createStoredSessionRecord('session-background-follow', metadata);
const resource = {
    linkGeneration: '1',
    occurrenceId: '',
};
let observation: ExternalSessionObservationLinkInput = {
    resource: {
        pluginId: 'happier.agent.claude',
        agentLocalId: 'claude',
        occurrenceId: resource.occurrenceId,
        resourceKey: 'resource-follow-recovery',
    },
    link: {
        sessionId: rawSession.id,
        linkGeneration: resource.linkGeneration,
        linkKey: 'link-follow-recovery',
        linkedSource: {
            source,
            remoteSessionId: 'remote-background-follow',
            linkData: { projectId: source.projectId },
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
};

const transcriptItem = (id: string, createdAtMs: number): ExternalSessionTranscriptRawMessageV1 => ({
    id,
    createdAtMs,
    raw: {},
});

describe('acquireCanonicalExternalSessionFollowLease background recovery', () => {
    let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
    let httpApp: FastifyInstance;
    let restoreHttpAdapter: () => void;
    let patchSpy: MockInstance<typeof axios.patch>;
    let publishMetadata: typeof axios.patch;
    let serverSession: ReturnType<typeof createStoredSessionRecord>;
    let beforeSessionResponse: (() => Promise<void>) | null;
    let sessionReads: number;

    beforeAll(async () => {
        runtimeFixture = await createAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.claude', 'happier.agent.codex'] },
        });
        const occurrenceId = runtimeFixture.registry.readPluginOccurrenceId?.('happier.agent.claude');
        if (!occurrenceId) throw new Error('Claude plugin occurrence was not admitted');
        resource.occurrenceId = occurrenceId;
        observation = {
            ...observation,
            resource: { ...observation.resource, occurrenceId },
        };
    });

    afterAll(async () => {
        await runtimeFixture?.dispose();
        runtimeFixture = null;
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', source.configDir);
        serverSession = rawSession;
        beforeSessionResponse = null;
        sessionReads = 0;
        httpApp = fastify();
        // Only the HTTP boundary is substituted: Account admission, Session parsing,
        // owner-envelope decoding and metadata tuple mutation stay real.
        httpApp.addHook('preHandler', async (request) => {
            expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        });
        httpApp.get('/v1/account/encryption/currentness', async () => (
            createAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 })
        ));
        httpApp.get<{ Params: { sessionId: string } }>('/v2/sessions/:sessionId', async (request) => {
            sessionReads += 1;
            expect(request.params.sessionId).toBe(serverSession.id);
            const pendingResponse = beforeSessionResponse;
            beforeSessionResponse = null;
            await pendingResponse?.();
            return { session: serverSession };
        });
        httpApp.patch<{ Params: { sessionId: string } }>('/v2/sessions/:sessionId', async (request, reply) => {
            expect(request.params.sessionId).toBe(serverSession.id);
            const patch = SessionMetadataTuplePatchV1Schema.parse(request.body);
            if (patch.mode !== 'owner') throw new Error('Expected an owner metadata tuple patch');
            if (patch.sharedMetadata.expectedVersion !== serverSession.metadataVersion) {
                return reply.code(409).send(SessionMetadataVersionConflictV1Schema.parse({
                    code: 'session_metadata_version_conflict',
                    metadataLayoutVersion: 1,
                    sharedMetadata: { version: serverSession.metadataVersion },
                    agentState: { version: serverSession.agentStateVersion },
                }));
            }
            expect(patch.sharedMetadata.expectedVersion).toBe(serverSession.metadataVersion);
            expect(patch.expectedOwnerMetadata).toEqual(serverSession.ownerMetadata);
            expect(patch.agentState.expectedVersion).toBe(serverSession.agentStateVersion);
            serverSession = {
                ...serverSession,
                metadata: patch.sharedMetadata.ciphertext,
                ownerMetadata: patch.ownerMetadata,
                metadataVersion: serverSession.metadataVersion + 1,
                agentState: patch.agentState.ciphertext,
                agentStateVersion: patch.agentState.expectedVersion + 1,
            };
            return {
                success: true,
                metadataLayoutVersion: 1,
                sharedMetadata: { version: serverSession.metadataVersion },
                agentState: { version: serverSession.agentStateVersion },
            };
        });
        await httpApp.ready();
        restoreHttpAdapter = installAxiosFastifyAdapter({
            app: httpApp,
            origin: new URL(resolveServerHttpBaseUrl()).origin,
        });
        publishMetadata = axios.patch.bind(axios);
        patchSpy = vi.spyOn(axios, 'patch');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        restoreHttpAdapter();
        await httpApp.close();
        vi.unstubAllEnvs();
    });

    function readPersistedMetadata() {
        return tryDecryptSessionOwnerMetadataView({
            credentials,
            rawSession: serverSession,
            accountEncryptionMode: 'plain',
        });
    }

    async function acquire(
        readAfterTranscript: NonNullable<
            ExternalSessionExecutionSurface['readAfterTranscript']
        >,
        pageTranscript: NonNullable<ExternalSessionExecutionSurface['pageTranscript']> = vi.fn(async () => ({
            items: [transcriptItem('resynced-item', 20)],
            nextCursor: null,
            tailCursor: 'cursor-resynced',
            hasMore: false,
            truncated: false,
        })),
        lifetime: Readonly<{ retirementSignal?: AbortSignal; initialCursor?: string | null }> = {},
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
                resource: { ...resource, ...(lifetime.retirementSignal ? { retirementSignal: lifetime.retirementSignal } : {}) },
                observation,
                providerOps: {
                    pageTranscript,
                    readAfterTranscript,
                },
                initialCursor: lifetime.initialCursor === undefined ? 'cursor-accepted' : lifetime.initialCursor,
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
        expect(patchSpy).toHaveBeenCalledOnce();
        expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(readPersistedMetadata()))
            .toMatchObject({
                remoteSessionId: 'remote-background-follow',
                linkedAtMs: 1,
                lastKnownActivityAtMs: 20,
            });

        await lease.requestTranscriptRefresh?.();
        expect(requestedCursors).toEqual([
            'cursor-accepted',
            'cursor-accepted',
            'cursor-resynced',
        ]);
    });

    it.each([
        {
            label: 'the source claims more history without a continuation',
            page: { nextCursor: null, hasMore: true, truncated: false },
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
        expect(patchSpy).not.toHaveBeenCalled();
    });

    it('drains true read-after continuation through the same source before accepting its final frontier', async () => {
        const requestedCursors: string[] = [];
        const { lease } = await acquire(async (input) => {
            requestedCursors.push(input.cursor);
            const continued = input.cursor === 'cursor-page-1';
            return {
                outcome: 'advanced',
                items: [transcriptItem(continued ? 'reply-last' : 'reply-first', continued ? 42 : 41)],
                nextCursor: continued ? 'cursor-complete' : 'cursor-page-1',
                boundary: continued ? 'reply-last' : 'reply-first',
                hasMore: !continued,
            };
        });
        sessionReads = 0;

        await expect(lease.requestTranscriptRefresh?.()).resolves.toEqual({ outcome: 'advanced' });
        expect(requestedCursors).toEqual(['cursor-accepted', 'cursor-page-1']);
        expect(sessionReads).toBe(1);
        expect(lease.readAcceptedCursor?.()).toBe('cursor-complete');
        expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(readPersistedMetadata()))
            .toMatchObject({ lastKnownActivityAtMs: 42 });
        await lease.release();
    });

    it('reconciles every gap-recovery page while preserving the original tail and newest progress', async () => {
        const fetchedCursors: Array<string | undefined> = [];
        const pageTranscript = vi.fn(async (input: Parameters<NonNullable<ExternalSessionExecutionSurface['pageTranscript']>>[0]) => {
            fetchedCursors.push(input.cursor);
            return input.cursor === undefined ? {
                items: [transcriptItem('newest-reply', 52)],
                nextCursor: 'older-page', tailCursor: 'captured-tail', hasMore: true, truncated: false,
            } : {
                items: [transcriptItem('older-reply', 51)],
                nextCursor: null, tailCursor: 'later-appended-tail', hasMore: false, truncated: false,
            };
        });
        const { lease } = await acquire(async () => ({ outcome: 'gap_or_cursor_expired' }), pageTranscript);
        const result = await lease.requestTranscriptRefresh?.();
        if (!result || result.outcome !== 'gap_or_cursor_expired') throw new Error('Expected gap recovery');
        sessionReads = 0;

        await expect(result.recover()).resolves.toBeUndefined();
        expect(fetchedCursors).toEqual([undefined, 'older-page']);
        expect(sessionReads).toBe(1);
        expect(lease.readAcceptedCursor?.()).toBe('captured-tail');
        expect(patchSpy).toHaveBeenCalledOnce();
        expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(readPersistedMetadata()))
            .toMatchObject({ lastKnownActivityAtMs: 52 });
        await lease.release();
    });

    it('retains the accepted frontier if the source is replaced during a continued read', async () => {
        const { lease } = await acquire(async ({ cursor }) => cursor === 'cursor-accepted' ? {
            outcome: 'advanced', items: [transcriptItem('uncommitted-first-page', 53)],
            nextCursor: 'cursor-first-page', boundary: 'uncommitted-first-page', hasMore: true,
        } : { outcome: 'source_replaced' });

        await expect(lease.requestTranscriptRefresh?.()).resolves.toEqual({ outcome: 'source_replaced' });
        expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
        expect(patchSpy).not.toHaveBeenCalled();
        await lease.release();
    });

    it('does not apply captured-source progress or its cursor to a concurrently relinked Session', async () => {
        const { lease } = await acquire(async () => {
            serverSession = {
                ...createStoredSessionRecord(rawSession.id, {
                    ...metadata,
                    externalSessionV1: { ...metadata.externalSessionV1, linkedAtMs: 2, remoteSessionId: 'replacement-source' },
                }),
                metadataVersion: rawSession.metadataVersion + 1,
            };
            return {
                outcome: 'advanced', items: [transcriptItem('old-source-reply', 54)],
                nextCursor: 'cursor-old-source', boundary: 'old-source-reply', hasMore: false,
            };
        });

        await expect(lease.requestTranscriptRefresh?.()).rejects.toThrow();
        expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
        expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(readPersistedMetadata()))
            .toMatchObject({ remoteSessionId: 'replacement-source', linkedAtMs: 2 });
        expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(readPersistedMetadata()))
            .not.toHaveProperty('lastKnownActivityAtMs');
        await lease.release();
    });

    it('revalidates an exact hosted owner during gap recovery without persisting a second link', async () => withTempDir('happier-hosted-follow-codex-', async (homePath) => {
        vi.stubEnv('CODEX_HOME', homePath);
        const hostedSource = {
            kind: 'codexHome' as const,
            home: 'user' as const,
            homePath,
        };
        const hostedMetadata = {
            machineId: 'machine-hosted-follow',
            flavor: 'codex',
            codexSessionId: 'thread-hosted-follow',
        };
        const hostedRawSession = {
            ...createStoredSessionRecord('session-hosted-follow', hostedMetadata),
            currentStorageState: 'hosted' as const,
        };
        serverSession = hostedRawSession;

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

        const hostedOccurrenceId = runtimeFixture?.registry.readPluginOccurrenceId?.('happier.agent.codex');
        if (!hostedOccurrenceId) throw new Error('Codex plugin occurrence was not admitted');
        const hostedResource = {
            linkGeneration: loaded.session.linkGeneration,
            occurrenceId: hostedOccurrenceId,
        };
        const hostedObservation: ExternalSessionObservationLinkInput = {
            ...observation,
            resource: {
                ...observation.resource,
                pluginId: 'happier.agent.codex',
                agentLocalId: 'codex',
                occurrenceId: hostedResource.occurrenceId,
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
        expect(lease.readAcceptedCursor?.()).toBe('cursor-hosted-resynced');
        expect(readPersistedMetadata()).not.toHaveProperty('externalSessionV1');
    }));

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
            expect(patchSpy).not.toHaveBeenCalled();
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
        patchSpy.mockRejectedValueOnce(new Error('progress publication rejected'));
        const { lease } = await acquire(readAfterTranscript);

        await expect(lease.requestTranscriptRefresh?.())
            .rejects.toThrow('progress publication rejected');
        await expect(lease.requestTranscriptRefresh?.())
            .resolves.toEqual({ outcome: 'advanced' });

        expect(requestedCursors).toEqual(['cursor-accepted', 'cursor-accepted']);
        expect(lease.readAcceptedCursor?.()).toBe('cursor-advanced');
    });

    it('does not complete release or advance the accepted cursor while progress publication is in flight', async () => {
        let releaseProgressPublication!: () => void;
        const progressPublication = new Promise<void>((resolve) => {
            releaseProgressPublication = resolve;
        });
        const publish = publishMetadata;
        patchSpy.mockImplementationOnce(async (...args) => {
            await progressPublication;
            return await publish(...args);
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
            expect(patchSpy).toHaveBeenCalledOnce();
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

    it('admits one bounded refresh once and commits its captured source before the next request re-admits', async () => {
        const { lease } = await acquire(async () => {
            // Withdrawal after native-read admission belongs to the next request.
            // The captured source still owns this read and its progress ACK.
            beforeSessionResponse = async () => { throw new Error('authority withdrawn'); };
            return {
                outcome: 'advanced',
                items: [transcriptItem('admitted-source-reply', 32)],
                nextCursor: 'cursor-admitted-source',
                boundary: 'admitted-source-reply',
                hasMore: false,
            };
        });
        sessionReads = 0;

        await expect(lease.requestTranscriptRefresh?.()).resolves.toEqual({ outcome: 'advanced' });
        expect(lease.readAcceptedCursor?.()).toBe('cursor-admitted-source');
        expect(sessionReads).toBe(1);
        expect(patchSpy).toHaveBeenCalledOnce();

        await expect(lease.requestTranscriptRefresh?.()).resolves.toBeUndefined();
        expect(lease.readAcceptedCursor?.()).toBe('cursor-admitted-source');
        expect(patchSpy).toHaveBeenCalledOnce();
        await lease.release();
    });

    it.each(['release', 'retirement'] as const)(
        'cancels an in-flight native stream read on %s without publishing or accepting its cursor',
        async (stop) => {
            const loaded = await loadLinkedExternalSession({
                credentials, sessionId: rawSession.id, machineId: 'machine-background-follow',
            });
            if (!loaded.ok) throw new Error(loaded.error);
            const retirement = new AbortController();
            let readSignal: AbortSignal | undefined;
            let finishRead!: () => void;
            let readStarted!: () => void;
            const started = new Promise<void>(resolve => { readStarted = resolve; });
            const lease = await acquireCanonicalExternalSessionFollowLease({
                sessionId: rawSession.id,
                machineId: 'machine-background-follow',
                linked: loaded.session,
                resource: { ...resource, retirementSignal: retirement.signal },
                observation,
                providerOps: {
                    pageTranscript: vi.fn(),
                    readAfterTranscript: async ({ signal }) => {
                        readSignal = signal;
                        await new Promise<void>(resolve => {
                            finishRead = resolve;
                            if (signal?.aborted) resolve();
                            else signal?.addEventListener('abort', () => resolve(), { once: true });
                            readStarted();
                        });
                        return {
                            outcome: 'advanced', items: [transcriptItem('cancelled-native-read', 60)],
                            nextCursor: 'cursor-cancelled-read', boundary: 'cancelled-native-read', hasMore: false,
                        };
                    },
                },
                initialCursor: 'cursor-accepted',
                maxBytes: 64_000,
                maxItems: 200,
                observationProjection: {
                    reconcileTranscriptDemand: async ({ demanded }) => ({ state: demanded ? 'observing' : 'not-demanded' }),
                },
                credentials,
            });
            const refresh = lease.requestTranscriptRefresh?.();
            await started;
            let release: Promise<void> | undefined;
            try {
                if (stop === 'release') release = lease.release();
                else retirement.abort();
                expect(readSignal?.aborted).toBe(true);
                await refresh;
                await (release ?? lease.release());
                expect(lease.readAcceptedCursor?.()).toBe('cursor-accepted');
                expect(patchSpy).not.toHaveBeenCalled();
            } finally {
                finishRead();
                await refresh;
                await lease.release();
            }
        },
    );

    it.each(['baseline', 'tail', 'recovery'] as const)(
        'passes the stream lifetime into a held %s page',
        async (phase) => {
            const retirement = new AbortController();
            let pageSignal: AbortSignal | undefined;
            let finishPage!: () => void;
            let pageStarted!: () => void;
            const started = new Promise<void>(resolve => { pageStarted = resolve; });
            let pages = 0;
            const acquisition = acquire(
                async () => ({ outcome: 'gap_or_cursor_expired' }),
                async ({ signal }) => {
                    pages += 1;
                    if (phase === 'tail' && pages === 1) {
                        return { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false };
                    }
                    pageSignal = signal;
                    await new Promise<void>(resolve => {
                        finishPage = resolve;
                        if (signal?.aborted) resolve();
                        else signal?.addEventListener('abort', () => resolve(), { once: true });
                        pageStarted();
                    });
                    return {
                        items: [transcriptItem('cancelled-native-page', 61)],
                        nextCursor: null, tailCursor: 'cursor-cancelled-page', hasMore: false, truncated: false,
                    };
                },
                { retirementSignal: retirement.signal, initialCursor: phase === 'recovery' ? 'cursor-accepted' : null },
            );
            // Observe acquisition rejection immediately: baseline cancellation
            // happens before a lease can be returned to its caller.
            const acquired = acquisition.then(value => ({ value }), (error: unknown) => ({ error }));
            let lease: Awaited<ReturnType<typeof acquire>>['lease'] | undefined;
            let work: Promise<unknown> | undefined;
            let release: Promise<void> | undefined;
            if (phase !== 'baseline') {
                lease = (await acquisition).lease;
                const refresh = lease.requestTranscriptRefresh?.();
                if (phase === 'recovery') {
                    const result = await refresh;
                    if (!result || result.outcome !== 'gap_or_cursor_expired') throw new Error('Expected gap recovery');
                    work = result.recover();
                } else work = refresh;
            }
            await started;
            try {
                if (phase === 'baseline') retirement.abort();
                else release = lease?.release();
                expect(pageSignal?.aborted).toBe(true);
                if (phase === 'baseline') {
                    expect(await acquired).toMatchObject({ error: { kind: 'source_changed' } });
                } else {
                    await work;
                    expect(lease?.readAcceptedCursor?.()).toBe(phase === 'tail' ? null : 'cursor-accepted');
                }
                expect(patchSpy).not.toHaveBeenCalled();
            } finally {
                finishPage();
                await work;
                await release;
                const result = await acquired;
                if ('value' in result) await result.value.lease.release();
            }
        },
    );

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
            code: 'follow_observer_not_observing',
            message: 'External Session live follow is unavailable: reconcile-only',
        });

        expect(demanded).toEqual([true, false]);
    });

    it.each([false, true])('refuses a reconcile-only source at canonical acquisition before demanding native reads (missing reads: %s)', async missingReads => {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
        });
        if (!loaded.ok) throw new Error(loaded.error);
        const demanded: boolean[] = [];
        const reads: string[] = [];
        await expect(acquireCanonicalExternalSessionFollowLease({
            sessionId: rawSession.id,
            machineId: 'machine-background-follow',
            linked: loaded.session,
            resource,
            observation: { ...observation, link: { ...observation.link, changeObservation: 'reconcile_only' } },
            providerOps: missingReads ? {} : {
                pageTranscript: async () => {
                    reads.push('page');
                    return { items: [], nextCursor: null, tailCursor: 'tail', hasMore: false, truncated: false };
                },
                readAfterTranscript: async () => {
                    reads.push('after');
                    return { outcome: 'already_current' };
                },
            },
            maxBytes: 64_000,
            maxItems: 200,
            observationProjection: {
                reconcileTranscriptDemand: async ({ demanded: demand }) => {
                    demanded.push(demand);
                    return { state: demand ? 'observing' : 'not-demanded' };
                },
            },
            credentials,
        })).rejects.toMatchObject({ kind: 'follow_unavailable', code: missingReads ? 'follow_transcript_reads_unavailable' : 'follow_live_observation_unavailable' });
        expect(demanded).toEqual([]);
        expect(reads).toEqual([]);
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
