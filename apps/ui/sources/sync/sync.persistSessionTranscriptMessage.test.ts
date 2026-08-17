import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createSessionFixture } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { PersistSessionTranscriptMessageInput } from '@/sync/domains/messages/persistSessionTranscriptMessage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { sync } from '@/sync/sync';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildVoiceTranscriptHistorySessionMetadata } from '@/voice/persistence/voiceTranscriptHistorySession';

const HISTORY_SESSION_ID = 'voice-history-stale-shell';

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
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
            return new Response('{}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return await request(input, init);
    });
}

describe('sync.persistSessionTranscriptMessage', () => {
    const originalEncryption = sync.encryption;
    const originalCredentials = Reflect.get(sync, 'credentials');
    let activeServerId: string;
    let credentials: AuthCredentials;
    let activeEncryption: Encryption;

    beforeEach(async () => {
        await resetServerReachabilitySupervisors();
        storage.setState(storage.getInitialState(), true);
        activeServerId = upsertServerProfile({
            serverUrl: 'https://voice-history-owner.example.test',
            name: 'Voice History owner',
        }).id;
        setActiveServerId(activeServerId, { scope: 'device' });
        storage.getState().activateProfileScope({
            serverId: activeServerId,
            accountId: 'voice-account-a',
        });

        const secretBytes = new Uint8Array(32).fill(7);
        credentials = {
            token: buildToken('voice-account-a'),
            secret: encodeBase64(secretBytes, 'base64url'),
        };
        activeEncryption = await Encryption.create(secretBytes);
        Reflect.set(sync, 'credentials', credentials);
        sync.encryption = activeEncryption;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        vi.spyOn(apiSocket, 'request').mockRejectedValue(
            new Error('dynamic active request must not own transcript persistence'),
        );
    });

    afterEach(async () => {
        await resetServerReachabilitySupervisors();
        resetRuntimeFetch();
        sync.encryption = originalEncryption;
        Reflect.set(sync, 'credentials', originalCredentials);
        vi.restoreAllMocks();
        storage.setState(storage.getInitialState(), true);
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
            if (url.endsWith(`/v2/sessions/${HISTORY_SESSION_ID}`)) {
                expect(init?.method).toBe('GET');
                return new Response(JSON.stringify({
                    session: {
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
                    },
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
        expect(apiSocket.request).not.toHaveBeenCalled();
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
        expect(apiSocket.request).not.toHaveBeenCalled();
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
        const request = vi.fn(async () => await postResponse);
        installRuntimeRequest(request);

        const persistence = sync.persistSessionTranscriptMessage(createTranscriptInput(
            'voice-realtime:stale-attempt:user:spoken-question',
            'stale spoken question',
        ));
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

        storage.getState().activateProfileScope({
            serverId: activeServerId,
            accountId: 'voice-account-b',
        });
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionMessages: {},
        }));
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
