import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { computeAccountEncryptionMigrateKeyFingerprintV1, projectSessionAccessCapabilitiesV1, V2SessionRecordSchema } from '@happier-dev/protocol';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';

installDisconnectedServerSocketBoundary();
installTokenStorageWebPlatformMocks();

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createSessionFixture } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import type { PersistSessionTranscriptMessageInput } from "@happier-dev/session-core/messages";
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer, switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import '@/sync/syncEngine';
import { sync } from '@/sync/sync';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildVoiceTranscriptHistorySessionMetadata } from '@/voice/persistence/voiceTranscriptHistorySession';
import { createVoiceTranscriptProjector } from '@/voice/transcript/VoiceTranscriptProjector';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const HISTORY_SESSION_ID = 'voice-history-stale-shell';
const SECRET_BYTES = new Uint8Array(32).fill(7);
let accountContentKey: Uint8Array;

function buildToken(accountId: string): string {
    const encode = (value: unknown) =>
        encodeBase64(new TextEncoder().encode(JSON.stringify(value)), 'base64url');
    return `${encode({ alg: 'none' })}.${encode({ sub: accountId })}.signature`;
}

function createAckResponse(localId: string, id = 'server-user-final'): Response {
    return new Response(JSON.stringify({
        didWrite: true,
        message: {
            id,
            seq: 1,
            localId,
            createdAt: 100,
        },
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createTranscriptInput(
    localId: string,
    text: string,
): PersistSessionTranscriptMessageInput {
    return {
        sessionId: HISTORY_SESSION_ID,
        localId,
        createdAt: 100,
        rawRecord: {
            role: 'user',
            content: { type: 'text', text },
            meta: {
                happier: {
                    kind: 'conversation_turn.v1',
                    payload: { v: 1 },
                    conversationTurnOriginV1: {
                        v: 1,
                        channel: 'realtime_conversation',
                        modality: 'voice',
                    },
                },
            },
        },
        messageRole: 'user' as const,
    };
}

function installRuntimeRequest(
    request: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): void {
    setRuntimeFetch(async (input, init) => {
        const url = String(input);
        const path = new URL(url).pathname;
        if (path === '/health' || path === '/v1/auth/ping') {
            return new Response('{}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url.endsWith('/v1/account/encryption/currentness')) return Response.json({
            mode: 'e2ee', version: 1, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
            signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(SECRET_BYTES)),
            contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(accountContentKey),
        });
        // Account bootstrap and the history write share real HTTP ownership;
        // keep neighboring bootstrap traffic outside the history responder.
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
        if (path === '/v1/account/profile') {
            const bearer = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '');
            const accountId = bearer === buildToken('voice-account-b') ? 'voice-account-b' : 'voice-account-a';
            return Response.json(AccountProfileSchema.parse({ id: accountId }));
        }
        if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
        if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
        if (path === '/v2/sessions/active' || path === '/v2/sessions') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        if (!path.startsWith('/v2/sessions/voice-history-')) return Response.json({}, { status: 404 });
        return await request(input, init);
    });
}

describe('sync.persistSessionTranscriptMessage', () => {
    let activeServerId: string;
    let credentials: AuthCredentials;
    let activeEncryption: Encryption;
    let localStorage: ReturnType<typeof installLocalStorageMock>;
    let webLocks: ReturnType<typeof installWebLockManagerMock>;

    beforeEach(async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        await resetServerReachabilitySupervisors();
        storage.setState(storage.getInitialState(), true);
        localStorage = installLocalStorageMock();
        webLocks = installWebLockManagerMock();
        const expectedEncryption = await Encryption.create(SECRET_BYTES);
        accountContentKey = expectedEncryption.contentDataKey;
        installRuntimeRequest(async () => Response.json({}, { status: 404 }));
        await loadSyncSingletonForTests();
        activeServerId = (await upsertServerProfile({
            serverUrl: 'https://voice-history-owner.example.test',
            name: 'Voice History owner',
        })).id;
        credentials = {
            token: buildToken('voice-account-a'),
            secret: encodeBase64(SECRET_BYTES, 'base64url'),
        };
        await setActiveServerId(activeServerId, { scope: 'device' });
        expect(await TokenStorage.setCredentials(credentials)).toBe(true);
        await restoreConnectionToActiveServer(credentials);
        if (!sync.encryption) throw new Error('Encrypted Account did not install its canonical encryption');
        activeEncryption = sync.encryption;
        vi.spyOn(apiSocket, 'request');
    });

    afterEach(async () => {
        await disconnectActiveServerConnection();
        await resetServerReachabilitySupervisors();
        resetRuntimeFetch();
        vi.restoreAllMocks();
        storage.setState(storage.getInitialState(), true);
        webLocks.restore();
        localStorage.restore();
        vi.unstubAllGlobals();
    });

    it('rehydrates a missing inactive history carrier before the canonical encrypted write and ACK commit', async () => {
        await activeEncryption.initializeSessions(new Map([[HISTORY_SESSION_ID, null]]));
        const historyEncryption = activeEncryption.getSessionEncryption(HISTORY_SESSION_ID);
        expect(historyEncryption).not.toBeNull();
        const encryptedMetadata = await historyEncryption!.encryptRaw({
            path: '/tmp/voice-history',
            host: 'test-host',
            ...buildVoiceTranscriptHistorySessionMetadata(),
        });
        const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            if (new URL(url).pathname === `/v2/sessions/${HISTORY_SESSION_ID}`) {
                expect(init?.method).toBe('GET');
                return new Response(JSON.stringify({
                    session: V2SessionRecordSchema.parse({
                        id: HISTORY_SESSION_ID,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 0,
                        active: false,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: null,
                        metadataVersion: 1,
                        metadata: encryptedMetadata,
                        agentStateVersion: 0,
                        agentState: null,
                        share: null,
                        metadataLayoutVersion: 0,
                        effectiveAccess: {
                            v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
                        },
                    }),
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith(`/v2/sessions/${HISTORY_SESSION_ID}/messages`)) {
                expect(init?.method).toBe('POST');
                expect(String(init?.body)).not.toContain('spoken question');
                return createAckResponse('voice-realtime:attempt:user:spoken-question');
            }
            throw new Error(`Unexpected Voice History request: ${url}`);
        });
        installRuntimeRequest(request);

        await expect(sync.persistSessionTranscriptMessage(createTranscriptInput(
            'voice-realtime:attempt:user:spoken-question',
            'spoken question',
        ))).resolves.toBeUndefined();

        expect(request).toHaveBeenCalledTimes(2);
        expect(vi.mocked(apiSocket.request).mock.calls.filter(([path]) => (
            new URL(path, 'https://voice-history-owner.example.test').pathname.startsWith(`/v2/sessions/${HISTORY_SESSION_ID}`)
        ))).toEqual([]);
        expect(readStoredSessionMessages(storage.getState(), HISTORY_SESSION_ID))
            .toEqual([
                expect.objectContaining({
                    realID: 'server-user-final',
                    seq: 1,
                    kind: 'user-text',
                    text: 'spoken question',
                }),
            ]);
        expect(storage.getState().sessions[HISTORY_SESSION_ID]).toMatchObject({
            active: false,
            lastViewedSessionSeq: 1,
            seq: 1,
        });
    });

    it('uses the warm active E2EE key and posts directly without rehydrating the carrier', async () => {
        await activeEncryption.initializeSessions(new Map([[HISTORY_SESSION_ID, null]]));
        storage.getState().applySessions([
            createSessionFixture({
                id: HISTORY_SESSION_ID,
                active: false,
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/voice-history',
                    host: 'test-host',
                    ...buildVoiceTranscriptHistorySessionMetadata(),
                },
            }),
        ]);
        const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            expect(url).toMatch(new RegExp(`/v2/sessions/${HISTORY_SESSION_ID}/messages$`));
            expect(init?.method).toBe('POST');
            return createAckResponse('voice-realtime:warm-attempt:user:spoken-question');
        });
        installRuntimeRequest(request);

        await expect(sync.persistSessionTranscriptMessage(createTranscriptInput(
            'voice-realtime:warm-attempt:user:spoken-question',
            'warm spoken question',
        ))).resolves.toBeUndefined();

        expect(request).toHaveBeenCalledOnce();
        expect(vi.mocked(apiSocket.request).mock.calls.filter(([path]) => (
            new URL(path, 'https://voice-history-owner.example.test').pathname.startsWith(`/v2/sessions/${HISTORY_SESSION_ID}`)
        ))).toEqual([]);
    });

    it('reconstructs one corrected canonical row after a higher revision waits behind the initial final ACK', async () => {
        storage.getState().applySessions([
            createSessionFixture({
                id: HISTORY_SESSION_ID,
                active: false,
                encryptionMode: 'plain',
                metadata: {
                    path: '/tmp/voice-history',
                    host: 'test-host',
                    ...buildVoiceTranscriptHistorySessionMetadata(),
                },
            }),
        ]);
        let resolveInitialPost!: () => void;
        const initialPost = new Promise<void>((resolve) => {
            resolveInitialPost = resolve;
        });
        let postCount = 0;
        const postedTexts: string[] = [];
        const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            expect(url).toMatch(new RegExp(`/v2/sessions/${HISTORY_SESSION_ID}/messages$`));
            expect(init?.method).toBe('POST');
            const body = JSON.parse(String(init?.body));
            const localId = String(body.localId);
            postedTexts.push(String(body.content?.v?.content?.text));
            postCount += 1;
            if (postCount === 1) await initialPost;
            return new Response(JSON.stringify({
                didWrite: postCount === 1,
                didUpdate: postCount === 2,
                message: {
                    id: 'server-corrected-user-turn',
                    seq: 1,
                    localId,
                    createdAt: 100,
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        installRuntimeRequest(request);
        const projector = createVoiceTranscriptProjector({
            getState: () => storage.getState(),
            persistFinal: (input) => sync.persistSessionTranscriptMessage(input),
        });

        projector.projectCanonicalEvent({
            conversationSessionId: HISTORY_SESSION_ID,
            event: {
                v: 1,
                type: 'voice.transcript.final',
                epoch: 1,
                sequence: 1,
                revision: 1,
                eventId: 'user-final-r1',
                itemId: 'user-turn',
                role: 'user',
                text: 'original spoken question',
                provenance: 'live',
            },
        });
        await vi.waitFor(() => expect(request.mock.calls.filter(([input, init]) => (
            new URL(String(input)).pathname === `/v2/sessions/${HISTORY_SESSION_ID}/messages` && init?.method === 'POST'
        ))).toHaveLength(1));

        projector.projectCanonicalEvent({
            conversationSessionId: HISTORY_SESSION_ID,
            event: {
                v: 1,
                type: 'voice.transcript.corrected',
                epoch: 1,
                sequence: 2,
                revision: 2,
                eventId: 'user-correction-r2',
                itemId: 'user-turn',
                role: 'user',
                text: 'corrected spoken question',
                provenance: 'live',
            },
        });
        expect(request).toHaveBeenCalledOnce();
        const attemptIdentity = projector.canonicalSnapshot(HISTORY_SESSION_ID)[0]?.attemptIdentity;
        expect(attemptIdentity).toEqual(expect.any(String));
        if (!attemptIdentity) throw new Error('canonical attempt identity was not projected');

        const drain = projector.releaseCanonicalConversation(HISTORY_SESSION_ID, attemptIdentity);
        resolveInitialPost();
        await expect(drain).resolves.toBe(true);

        expect(postedTexts).toEqual(['original spoken question', 'corrected spoken question']);
        const reloadedMessages = readStoredSessionMessages(storage.getState(), HISTORY_SESSION_ID);
        expect(reloadedMessages).toEqual([
            expect.objectContaining({
                realID: 'server-corrected-user-turn',
                localId: expect.stringMatching(/^voice-realtime:[^:]+:user:user-turn$/),
                kind: 'user-text',
                text: 'corrected spoken question',
            }),
        ]);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('retires a cached history carrier after its authoritative message POST reports it absent, without retrying that final', async () => {
        const freshHistorySessionId = 'voice-history-fresh-shell';
        storage.getState().applySessions([
            createSessionFixture({
                id: HISTORY_SESSION_ID,
                active: false,
                encryptionMode: 'plain',
                metadata: {
                    path: '/tmp/voice-history',
                    host: 'test-host',
                    ...buildVoiceTranscriptHistorySessionMetadata(),
                },
            }),
        ]);
        const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/v2/session-organization')) {
                return new Response(JSON.stringify({
                    snapshot: {
                        schemaVersion: 1,
                        version: 0,
                        pins: [],
                        folders: [],
                        folderAssignments: [],
                        tags: [],
                        tagAssignments: [],
                        orderEntries: [],
                        labels: [],
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.includes('/v2/sessions?')) {
                return new Response(JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            expect(init?.method).toBe('POST');
            if (url.endsWith(`/v2/sessions/${HISTORY_SESSION_ID}/messages`)) {
                return new Response(JSON.stringify({ error: 'Session not found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith(`/v2/sessions/${freshHistorySessionId}/messages`)) {
                return createAckResponse('voice-realtime:fresh-attempt:user:spoken-question', 'server-fresh-user-final');
            }
            throw new Error(`Unexpected Voice History request: ${url}`);
        });
        installRuntimeRequest(request);

        await expect(sync.persistSessionTranscriptMessage(createTranscriptInput(
            'voice-realtime:stale-attempt:user:spoken-question',
            'stale spoken question',
        ))).rejects.toThrow('Session transcript message write failed (404)');

        const messagePosts = () => request.mock.calls.filter(([input]) => (
            String(input).endsWith('/messages')
        ));
        expect(messagePosts()).toHaveLength(1);
        expect(storage.getState().sessions[HISTORY_SESSION_ID]).toBeUndefined();
        expect(readStoredSessionMessages(storage.getState(), HISTORY_SESSION_ID)).toEqual([]);

        // Carrier creation stays with the direct-media owner. Once it has supplied
        // a fresh carrier, the next final can use that carrier normally.
        storage.getState().applySessions([
            createSessionFixture({
                id: freshHistorySessionId,
                active: false,
                encryptionMode: 'plain',
                metadata: {
                    path: '/tmp/voice-history',
                    host: 'test-host',
                    ...buildVoiceTranscriptHistorySessionMetadata(),
                },
            }),
        ]);
        await expect(sync.persistSessionTranscriptMessage({
            ...createTranscriptInput(
                'voice-realtime:fresh-attempt:user:spoken-question',
                'fresh spoken question',
            ),
            sessionId: freshHistorySessionId,
        })).resolves.toBeUndefined();

        expect(messagePosts()).toHaveLength(2);
        expect(readStoredSessionMessages(storage.getState(), freshHistorySessionId)).toEqual([
            expect.objectContaining({
                realID: 'server-fresh-user-final',
                localId: 'voice-realtime:fresh-attempt:user:spoken-question',
                text: 'fresh spoken question',
            }),
        ]);
    });

    it('preserves an encrypted history carrier for a route-shaped transcript POST 404', async () => {
        await activeEncryption.initializeSessions(new Map([[HISTORY_SESSION_ID, null]]));
        const removeSessionEncryption = vi.spyOn(activeEncryption, 'removeSessionEncryption');
        storage.getState().applySessions([
            createSessionFixture({
                id: HISTORY_SESSION_ID,
                active: false,
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/voice-history',
                    host: 'test-host',
                    ...buildVoiceTranscriptHistorySessionMetadata(),
                },
            }),
        ]);
        storage.getState().applyMessages(HISTORY_SESSION_ID, [{
            id: 'preexisting-history-message',
            localId: null,
            createdAt: 99,
            role: 'user',
            content: { type: 'text', text: 'already persisted' },
            seq: 1,
            isSidechain: false,
        } satisfies NormalizedMessage]);
        const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            expect(url).toMatch(new RegExp(`/v2/sessions/${HISTORY_SESSION_ID}/messages$`));
            expect(init?.method).toBe('POST');
            return new Response(JSON.stringify({
                error: 'Not found',
                path: `/v2/sessions/${HISTORY_SESSION_ID}/messages`,
                method: 'POST',
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        installRuntimeRequest(request);

        await expect(sync.persistSessionTranscriptMessage(createTranscriptInput(
            'voice-realtime:compatibility-attempt:user:spoken-question',
            'do not retire this carrier',
        ))).rejects.toThrow('Session transcript message write failed (404)');

        expect(request).toHaveBeenCalledOnce();
        expect(storage.getState().sessions[HISTORY_SESSION_ID]).toEqual(expect.objectContaining({
            id: HISTORY_SESSION_ID,
            encryptionMode: 'e2ee',
        }));
        expect(readStoredSessionMessages(storage.getState(), HISTORY_SESSION_ID)).toEqual([
            expect.objectContaining({
                realID: 'preexisting-history-message',
                text: 'already persisted',
            }),
        ]);
        expect(activeEncryption.getSessionEncryption(HISTORY_SESSION_ID)).not.toBeNull();
        expect(removeSessionEncryption).not.toHaveBeenCalled();
    });

    it('preserves an encrypted history carrier for a current-text transcript POST 404 with route metadata', async () => {
        await activeEncryption.initializeSessions(new Map([[HISTORY_SESSION_ID, null]]));
        const removeSessionEncryption = vi.spyOn(activeEncryption, 'removeSessionEncryption');
        storage.getState().applySessions([
            createSessionFixture({
                id: HISTORY_SESSION_ID,
                active: false,
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/voice-history',
                    host: 'test-host',
                    ...buildVoiceTranscriptHistorySessionMetadata(),
                },
            }),
        ]);
        storage.getState().applyMessages(HISTORY_SESSION_ID, [{
            id: 'preexisting-history-message',
            localId: null,
            createdAt: 99,
            role: 'user',
            content: { type: 'text', text: 'already persisted' },
            seq: 1,
            isSidechain: false,
        } satisfies NormalizedMessage]);
        const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            expect(url).toMatch(new RegExp(`/v2/sessions/${HISTORY_SESSION_ID}/messages$`));
            expect(init?.method).toBe('POST');
            return new Response(JSON.stringify({
                error: 'Session not found',
                path: `/v2/sessions/${HISTORY_SESSION_ID}/messages`,
                method: 'POST',
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        installRuntimeRequest(request);

        await expect(sync.persistSessionTranscriptMessage(createTranscriptInput(
            'voice-realtime:current-text-extra-attempt:user:spoken-question',
            'do not retire this carrier',
        ))).rejects.toThrow('Session transcript message write failed (404)');

        expect(storage.getState().sessions[HISTORY_SESSION_ID]).toEqual(expect.objectContaining({
            id: HISTORY_SESSION_ID,
            encryptionMode: 'e2ee',
        }));
        expect(readStoredSessionMessages(storage.getState(), HISTORY_SESSION_ID)).toEqual([
            expect.objectContaining({
                realID: 'preexisting-history-message',
                text: 'already persisted',
            }),
        ]);
        expect(activeEncryption.getSessionEncryption(HISTORY_SESSION_ID)).not.toBeNull();
        expect(removeSessionEncryption).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledOnce();
    });

    it('rejects an ACK from the captured account after the active account switches during POST', async () => {
        await activeEncryption.initializeSessions(new Map([[HISTORY_SESSION_ID, null]]));
        storage.getState().applySessions([
            createSessionFixture({
                id: HISTORY_SESSION_ID,
                active: false,
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/voice-history',
                    host: 'test-host',
                    ...buildVoiceTranscriptHistorySessionMetadata(),
                },
            }),
        ]);

        let resolvePost!: (response: Response) => void;
        const postResponse = new Promise<Response>((resolve) => {
            resolvePost = resolve;
        });
        const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            if (String(input).endsWith(`/v2/sessions/${HISTORY_SESSION_ID}/messages`) && init?.method === 'POST') return await postResponse;
            return Response.json({}, { status: 404 });
        });
        installRuntimeRequest(request);

        const persistence = sync.persistSessionTranscriptMessage(createTranscriptInput(
            'voice-realtime:stale-attempt:user:spoken-question',
            'stale spoken question',
        ));
        await vi.waitFor(() => expect(request.mock.calls.filter(([input, init]) => (
            new URL(String(input)).pathname === `/v2/sessions/${HISTORY_SESSION_ID}/messages` && init?.method === 'POST'
        ))).toHaveLength(1));

        const replacement = { token: buildToken('voice-account-b'), secret: encodeBase64(SECRET_BYTES, 'base64url') };
        expect(await TokenStorage.setCredentials(replacement)).toBe(true);
        // AuthContext adopts persisted replacement credentials through the switch owner.
        await switchConnectionToActiveServer();
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        expect(getActiveServerAccountScope()).toMatchObject({ accountId: 'voice-account-b' });
        expect((sync as unknown as { credentials: AuthCredentials | null }).credentials?.token).toBe(replacement.token);
        resolvePost(createAckResponse(
            'voice-realtime:stale-attempt:user:spoken-question',
            'stale-server-user-final',
        ));

        await expect(persistence).rejects.toThrow(
            'Voice transcript persistence server-account scope changed',
        );
        expect(readStoredSessionMessages(storage.getState(), HISTORY_SESSION_ID)).toEqual([]);
        expect(storage.getState().sessions[HISTORY_SESSION_ID]).toBeUndefined();
    });
});
