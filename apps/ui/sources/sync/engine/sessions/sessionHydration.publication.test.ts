import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeCrypto from 'rn-encryption';
import tweetnacl from 'tweetnacl';
import { sealEncryptedDataKeyEnvelopeV1, type AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import { createDeferred, createSessionFixture, createSessionAccessFixture } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fetchAndApplySessionById } from './sessionById';
import { fetchAndApplySessions } from './sessionSnapshot';
import { parseDecryptedSessionMetadata } from './parsePlainSessionPayload';
import { flushActivityUpdates, handleUpdateContainer } from '../socket/socket';

const currentness = {
    mode: 'e2ee', version: 1, updatedAt: 1,
    signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current',
    recipientEnvelopeReadiness: { status: 'available' },
} satisfies AccountEncryptionCurrentnessResponse;
const sharedMetadata = { v: 1, summary: { text: 'Known shared title', updatedAt: 1 } };
const sessionId = 'hydration-publication';
const serverId = 'home-publication';
const initialStorageState = storage.getInitialState();

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function createHydrationContext() {
    const keys = tweetnacl.box.keyPair();
    const credentials = { token: 't', encryption: {
        publicKey: encodeBase64(keys.publicKey), machineKey: encodeBase64(keys.secretKey),
    } };
    const encryption = await Encryption.createFromContentKeyPair({ publicKey: keys.publicKey, machineKey: keys.secretKey });
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const dataKey = new Uint8Array(32).fill(7);
    await encryption.initializeSessions(new Map([[sessionId, dataKey]]), { serverId });
    const metadata = await encryption.getSessionEncryption(sessionId)!.encryptRaw(sharedMetadata);
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey, recipientPublicKey: keys.publicKey,
        randomBytes: (length) => new Uint8Array(length).fill(3),
    }));
    const row = {
        id: sessionId, seq: 3, createdAt: 1, updatedAt: 2, active: true, activeAt: 2, archivedAt: null,
        encryptionMode: 'e2ee' as const, dataEncryptionKey: envelope,
        metadataLayoutVersion: 1, metadataVersion: 4, metadata,
        agentStateVersion: 5, agentState: null,
        share: { accessLevel: 'view', canApprovePermissions: false },
    };
    const session = createSessionFixture({
        ...row, encryptionMode: 'e2ee', serverId,
        metadata: parseDecryptedSessionMetadata(sharedMetadata, 1),
        ownerMetadataView: null, access: createSessionAccessFixture('view'), accessLevel: 'view',
    });
    storage.setState({ sessions: { [sessionId]: session }, sessionListRowsByServerId: {} });
    const sessionDataKeys = new Map([[sessionId, dataKey]]);
    const sessionDataKeyEnvelopes = new Map([[sessionId, envelope]]);
    const params = {
        serverId, credentials, accountCurrentness: currentness, encryption,
        sessionDataKeys, sessionDataKeyEnvelopes,
        applySessions: storage.getState().applySessions,
        getExistingSession: (id: string) => storage.getState().sessions[id],
        log: { log: () => {} },
    };
    return { row, params, encryption };
}

afterEach(() => {
    vi.restoreAllMocks();
    storage.setState(initialStorageState, true);
});

describe('Session hydration publication', () => {
    it('excludes a plaintext wire title from parsed HTTP hydration and list publication', async () => {
        const { row, params } = await createHydrationContext();
        const wireTitle = 'Untrusted plaintext wire title';
        const published: Array<Parameters<typeof params.applySessions>[0][number]> = [];
        storage.setState({ sessions: {} });
        await fetchAndApplySessions({
            ...params,
            awaitSessionListHydration: true,
            request: async () => jsonResponse({ sessions: [{ ...row, lockedDisplayTitle: wireTitle }], hasNext: false }),
            applySessions: (sessions) => {
                published.push(...sessions);
                params.applySessions(sessions);
            },
        });
        expect(published).toHaveLength(1);
        expect(published[0]).not.toHaveProperty('lockedDisplayTitle');
        expect(getSessionName(storage.getState().sessions[sessionId])).toBe(sharedMetadata.summary.text);
        expect(getSessionName(storage.getState().sessionListRowsByServerId[serverId][sessionId])).toBe(sharedMetadata.summary.text);
    });

    it('retains observed presence across durable by-ID hydration', async () => {
        const { row, params } = await createHydrationContext();
        expect(storage.getState().sessions[sessionId].presence).toBe('online');
        expect(Object.hasOwn(row, 'presence')).toBe(false);

        const result = await fetchAndApplySessionById({
            ...params, sessionId, includeTurnsProjection: false,
            request: async () => jsonResponse({ session: row }),
        });

        expect(result.ok).toBe(true);
        expect(storage.getState().sessions[sessionId].presence).toBe('online');
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]?.presence).toBe('online');
    });

    it('applies explicit ephemeral offline and online observations to hydrated sessions', async () => {
        const { params } = await createHydrationContext();
        const observe = (active: boolean, activeAt: number) => flushActivityUpdates({
            updates: new Map([[sessionId, { type: 'activity', id: sessionId, active, activeAt, thinking: false }]]),
            applySessions: params.applySessions,
            sourceServerId: serverId,
        });

        observe(false, 3);
        expect(storage.getState().sessions[sessionId].presence).toBe(3);
        const { presence: _presence, ...durableSession } = storage.getState().sessions[sessionId];
        params.applySessions([durableSession]);
        expect(storage.getState().sessions[sessionId].presence).toBe(3);
        observe(true, 4);
        expect(storage.getState().sessions[sessionId].presence).toBe('online');
    });

    it('routes ephemeral presence to its Home when another Home has hydrated the same Session id', async () => {
        const { params } = await createHydrationContext();
        const hydrated = storage.getState().sessions[sessionId];
        const otherHome = 'other-home';
        storage.setState({ sessionListRowsByServerId: {
            [otherHome]: { [sessionId]: buildSessionListRenderableFromSession({ ...hydrated, serverId: otherHome }) },
        } });

        flushActivityUpdates({
            updates: new Map([[sessionId, { type: 'activity', id: sessionId, active: false, activeAt: 3, thinking: false }]]),
            applySessions: params.applySessions,
            sourceServerId: otherHome,
        });

        expect(storage.getState().sessions[sessionId]).toBe(hydrated);
        await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[otherHome]?.[sessionId]).toMatchObject({
            active: false, presence: 3,
        }));
    });

    it('preserves omitted presence only within its Home and never overrides explicit invalidation', async () => {
        const { params } = await createHydrationContext();
        const { presence: _presence, ...durableSession } = storage.getState().sessions[sessionId];

        params.applySessions([{ ...durableSession, presence: undefined }]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();
        params.applySessions([durableSession]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();

        params.applySessions([{ ...durableSession, presence: 'online' }]);
        params.applySessions([{ ...durableSession, serverId: 'another-home' }]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();

        storage.setState({ sessions: {} });
        params.applySessions([durableSession]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();
    });

    it('does not publish stale socket metadata after by-ID hydration cleared its reader', async () => {
        const { row, params, encryption } = await createHydrationContext();
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const decrypt = nativeCrypto.decryptAsyncAES;
        // Delay only the platform crypto operation, retaining the real socket owner.
        vi.spyOn(nativeCrypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
            started.resolve();
            await release.promise;
            return await decrypt(...args);
        });
        const socket = handleUpdateContainer({
            updateData: { id: 'update', seq: 3, createdAt: 2, body: { ...row, t: 'new-session' } },
            encryption, sourceServerId: serverId, artifactDataKeys: new Map(),
            applySessions: params.applySessions, fetchSessions: () => {},
            applyMessages: () => {}, onSessionVisible: () => {}, isSessionMessagesLoaded: () => false,
            getSessionMaterializedMaxSeq: () => 0, markSessionMaterializedMaxSeq: () => {},
            onMessageGapDetected: () => {}, assumeUsers: async () => {}, applyTodoSocketUpdates: async () => {},
            invalidateMachines: () => {}, invalidateSessions: () => {}, invalidateArtifacts: () => {},
            invalidateFriends: () => {}, invalidateFriendRequests: () => {}, invalidateFeed: () => {},
            invalidateAutomations: () => {}, invalidateTodos: () => {}, log: params.log,
        });
        await started.promise;
        try {
            await fetchAndApplySessionById({
                ...params, sessionId, includeTurnsProjection: false,
                request: async () => jsonResponse({ session: { ...row, dataEncryptionKey: 'unopenable-envelope' } }),
            });
            expect(storage.getState().sessions[sessionId].encryptedContentAvailability).toBe('encrypted_access_needs_repair');
        } finally {
            release.resolve();
        }
        await socket;
        expect(storage.getState().sessions[sessionId]).toMatchObject({
            metadata: null, encryptedContentAvailability: 'encrypted_access_needs_repair',
        });
    });

    it('does not publish an old successful decrypt after its reader was cleared during foreground hydration', async () => {
        const { row, params, encryption } = await createHydrationContext();
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const decrypt = nativeCrypto.decryptAsyncAES;
        // The native AES boundary is delayed; hydration, crypto, generation ownership,
        // tuple ordering, store application and display projections remain real.
        vi.spyOn(nativeCrypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
            started.resolve();
            await release.promise;
            return await decrypt(...args);
        });
        const snapshot = fetchAndApplySessions({
            ...params,
            request: async () => jsonResponse({ sessions: [row], nextCursor: null, hasNext: false }),
        });
        await started.promise;
        try {
            const locked = await fetchAndApplySessionById({
                ...params, sessionId, includeTurnsProjection: false,
                request: async () => jsonResponse({ session: { ...row, dataEncryptionKey: 'unopenable-envelope' } }),
            });
            expect(locked.ok).toBe(true);
            expect(encryption.getSessionEncryption(sessionId)).toBeNull();
            expect(storage.getState().sessions[sessionId].encryptedContentAvailability).toBe('encrypted_access_needs_repair');
        } finally {
            release.resolve();
        }
        await snapshot;
        expect(storage.getState().sessions[sessionId]).toMatchObject({
            metadata: null, encryptedContentAvailability: 'encrypted_access_needs_repair',
        });
    });

    it('keeps only the shared title through a recipient lock and drops it when access or Home changes', async () => {
        const { row, params } = await createHydrationContext();
        await fetchAndApplySessionById({
            ...params, sessionId, includeTurnsProjection: false,
            request: async () => jsonResponse({ session: { ...row, dataEncryptionKey: 'unopenable-envelope' } }),
        });
        const locked = storage.getState().sessions[sessionId];
        expect(locked.metadata).toBeNull();
        expect(locked.ownerMetadataView).toBeNull();
        expect(getSessionName(locked)).toBe(sharedMetadata.summary.text);
        expect(getSessionName(buildSessionListRenderableFromSession(locked))).toBe(sharedMetadata.summary.text);

        storage.getState().applySessions([{ ...locked,
            encryptedContentAvailability: 'ready', metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
        }]);
        expect(getSessionName(storage.getState().sessions[sessionId])).not.toBe(sharedMetadata.summary.text);

        storage.getState().applySessions([{ ...locked, serverId: 'other-home' }]);
        expect(getSessionName(storage.getState().sessions[sessionId])).not.toBe(sharedMetadata.summary.text);
        storage.getState().applySessions([{ ...locked, access: createSessionAccessFixture('owner'), accessLevel: undefined }]);
        const owner = storage.getState().sessions[sessionId];
        expect(getSessionName(owner)).not.toBe(sharedMetadata.summary.text);
        expect(isUserFacingSession(owner)).toBe(false);
    });

    it('retains the trusted locked title during a warm HTTP list refresh without accepting a wire title', async () => {
        const { row, params } = await createHydrationContext();
        const lockedRow = { ...row, dataEncryptionKey: 'unopenable-envelope', lockedDisplayTitle: 'Untrusted wire title' };
        await fetchAndApplySessionById({
            ...params, sessionId, includeTurnsProjection: false,
            request: async () => jsonResponse({ session: lockedRow }),
        });
        const published: SessionListRenderableSession[] = [];
        await fetchAndApplySessions({
            ...params, awaitSessionListHydration: true, requiredHydrationSessionIds: [sessionId],
            request: async () => jsonResponse({ sessions: [lockedRow], hasNext: false }),
            getCurrentSessionListRenderable: (id) => storage.getState().sessionListRowsByServerId[serverId]?.[id],
            applySessionListRenderables: (rows) => published.push(...rows),
        });
        expect(published).toHaveLength(1);
        expect(getSessionName(published[0])).toBe(sharedMetadata.summary.text);
        expect(published[0].metadata).toBeNull();
        expect(published[0].lockedDisplayTitle).toBe(sharedMetadata.summary.text);
    });
});
