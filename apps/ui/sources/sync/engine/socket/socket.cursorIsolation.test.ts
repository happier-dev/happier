import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import * as persistence from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { flushActivityUpdates, handleSocketUpdate, handleUpdateContainer } from './socket';
import { markSessionSurfaceVisible, resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDeferred } from '@/dev/testkit';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { V2SessionRecordSchema} from '@happier-dev/protocol/sessions/control/contract';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();

const initialStorageState = storage.getInitialState();
let encryption: Encryption;

function buildSession(sessionId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildBaseParams(overrides: Partial<Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'>> = {}) {
    return {
        encryption,
        artifactDataKeys: new Map(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => false),
        getSessionMaterializedMaxSeq: vi.fn(() => 0),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateMachines: vi.fn(),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket update handling cursor isolation', () => {
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let runtime: typeof import('@/sync/syncEngine')['sync'];
    const sessionRequests: string[] = [];
    let heldSessionDetail: Promise<Response> | null = null;
    const servedSessionRecords = new Map<string, unknown>();

    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        resetSessionSurfaceVisibilityForTests();
        const secret = new Uint8Array(32).fill(7);
        encryption = await Encryption.create(secret);
        sessionRequests.length = 0;
        heldSessionDetail = null;
        servedSessionRecords.clear();
        account = await restoreServerAccountForTest({
            serverUrl: 'https://socket-cursor.example',
            credentials: { token: createAccountTokenForTests('account-a'), secret: encodeBase64(secret, 'base64url') },
            request: createSessionReadBatchFetchBoundary(async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({
                    mode: 'e2ee', version: 1, updatedAt: 1,
                    signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(secret)),
                    contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(encryption.contentDataKey),
                    recipientEnvelopeReadiness: { status: 'available' },
                });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
                    schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [], folderAssignments: [],
                    tags: [], tagAssignments: [], orderEntries: [], labels: [],
                } }));
                if (path.startsWith('/v2/sessions')) sessionRequests.push(path);
                if (path === '/v2/sessions/s_new' && heldSessionDetail) return heldSessionDetail;
                const servedRecord = servedSessionRecords.get(path.slice('/v2/sessions/'.length));
                if (servedRecord) return Response.json({ session: servedRecord });
                if (path === '/v2/sessions' || path === '/v2/sessions/active') {
                    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            }),
        });
        runtime = (await import('@/sync/syncEngine')).sync;
        // Account restoration starts a real list bootstrap. Observe its settled
        // publication before attributing any later request to this socket body.
        await vi.waitFor(() => expect(
            storage.getState().concurrentSessionListCacheByServerId[account.serverId]?.listObservation?.lastSuccessAt,
        ).toEqual(expect.any(Number)));
        sessionRequests.length = 0;
    });

    afterEach(async () => {
        vi.useRealTimers();
        resetSessionSurfaceVisibilityForTests();
        await account.dispose();
        vi.restoreAllMocks();
    });

    it('keeps unsolicited new Sessions out of full storage until their surface demands them', async () => {
        const sessionId = 's_unseen_new';
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({
            sourceServerId: account.serverId,
            applySessions: rows => storage.getState().applySessions(rows),
            hydrateSessionById,
        });
        const update: ApiUpdateContainer = {
            id: 'unseen-new', seq: 2, createdAt: 2,
            body: {
                t: 'new-session', id: sessionId, seq: 1,
                metadata: JSON.stringify({ path: '/work', host: 'test' }), metadataVersion: 1,
                agentState: JSON.stringify({}), agentStateVersion: 1,
                encryptionMode: 'plain', dataEncryptionKey: null,
                active: true, activeAt: 2, createdAt: 1, updatedAt: 2,
            },
        };

        await handleSocketUpdate({ ...params, update });
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(hydrateSessionById).not.toHaveBeenCalled();
        expect(params.invalidateSessions).toHaveBeenCalled();

        markSessionSurfaceVisible(sessionId, account.serverId);
        await handleSocketUpdate({ ...params, update });
        expect(storage.getState().sessions[sessionId]?.metadata).toEqual({ path: '/work', host: 'test' });
        expect(hydrateSessionById).toHaveBeenCalledWith(sessionId, 'socket-new-session-reconcile');
    });

    it.each(['update-session', 'pending-changed', 'session-shared'] as const)(
        'reads an unseen missing row through the row owner instead of hydrating it after %s',
        async (type) => {
            const sessionId = `s_unseen_${type}`;
            const hydrateSessionById = vi.fn();
            const refreshSessionRows = vi.fn();
            const params = buildBaseParams({ sourceServerId: account.serverId, hydrateSessionById, refreshSessionRows });
            const body = type === 'update-session'
                ? { t: type, id: sessionId, active: true, activeAt: 2 }
                : type === 'pending-changed'
                    ? { t: type, sid: sessionId, pendingCount: 1, pendingVersion: 1 }
                    : { t: type, sessionId, shareId: 'share-test', accessLevel: 'view', canApprovePermissions: false,
                        sharedBy: { id: 'owner', firstName: null, lastName: null, username: 'owner', avatar: null }, createdAt: 2 };
            await handleSocketUpdate({ ...params, update: { id: 'unseen-update', seq: 2, createdAt: 2, body } });
            expect(hydrateSessionById).not.toHaveBeenCalled();
            expect(refreshSessionRows).toHaveBeenCalledWith([sessionId]);
            expect(params.invalidateSessions).not.toHaveBeenCalled();
            expect(storage.getState().sessions[sessionId]).toBeUndefined();
        },
    );

    it('reads an unloaded streaming Session row through the row owner instead of re-reading the Session list', async () => {
        const sessionId = 's_unloaded_stream';
        servedSessionRecords.set(sessionId, V2SessionRecordSchema.parse({
            id: sessionId, seq: 3, createdAt: 1, updatedAt: 2, active: true, activeAt: 2,
            encryptionMode: 'plain', metadata: JSON.stringify({ path: '/elsewhere', host: 'test' }), metadataVersion: 1,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        }));
        const socketOwner = runtime as unknown as { handleUpdate(update: unknown): Promise<void> };
        const sessionsQueue = Reflect.get(runtime, 'sessionsSync') as { awaitQueue(): Promise<unknown> };
        // Another device streams a turn in a Session this client has not loaded: each turn
        // checkpoint arrives as a row-level update-session frame.
        for (let seq = 2; seq <= 6; seq += 1) {
            await socketOwner.handleUpdate({ id: `unloaded-${seq}`, seq, createdAt: seq,
                body: { t: 'update-session', id: sessionId, active: true, activeAt: seq, thinking: seq % 2 === 0 } });
            await sessionsQueue.awaitQueue();
        }
        const fullListReads = sessionRequests.filter((path) => path === '/v2/sessions' || path === '/v2/sessions/active');
        expect(fullListReads).toEqual([]);
        await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[account.serverId]?.[sessionId]).toBeDefined());
        expect(sessionRequests.filter((path) => path === `/v2/sessions/${sessionId}`).length).toBeGreaterThan(0);
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
    });

    it('defers encrypted cache-only metadata until the Session has a content consumer', async () => {
        const sessionId = 's_unseen_cached_metadata';
        await encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(8)]]));
        const sessionEncryption = encryption.getSessionEncryption(sessionId)!;
        const metadata = { path: '/new-work', host: 'test' };
        const ciphertext = await sessionEncryption.encryptRaw(metadata);
        const decryptMetadata = vi.spyOn(sessionEncryption, 'decryptMetadata');
        storage.getState().applyServerScopedSessionListRows(account.serverId, [
            buildSessionListRenderableFromSession({ ...buildSession(sessionId), serverId: account.serverId,
                metadata: { path: '/old-work', host: 'test' }, metadataVersion: 1 }),
        ], { source: 'ordinary', mode: 'replace' });
        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({ sourceServerId: account.serverId, markSessionStateHydrationDeferred });
        const update: ApiUpdateContainer = { id: 'unseen-metadata', seq: 2, createdAt: 2,
            body: { t: 'update-session', id: sessionId, metadata: { version: 2, value: ciphertext },
                pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 } };

        await handleSocketUpdate({ ...params, update });
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessionListRowsByServerId[account.serverId][sessionId]).toMatchObject({
            metadataVersion: 1, metadata: { path: '/old-work', host: 'test' }, hasPendingPermissionRequests: true,
        });
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith(sessionId);

        markSessionSurfaceVisible(sessionId, account.serverId);
        await handleSocketUpdate({ ...params, update });
        expect(decryptMetadata).toHaveBeenCalled();
        expect(storage.getState().sessionListRowsByServerId[account.serverId][sessionId].metadata?.path).toBe('/new-work');
    });

    it('targets an absent envelope and clears pending availability when a valid socket envelope arrives', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { sealEncryptedDataKeyEnvelopeV1} = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
        const sessionId = 'socket_pending_recipient';
        markSessionSurfaceVisible(sessionId);
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const writer = await Encryption.create(new Uint8Array(32).fill(7));
        const sessionKey = new Uint8Array(32).fill(8);
        await writer.initializeSessions(new Map([[sessionId, sessionKey]]));
        const metadata = { path: '/shared', host: 'shared-host', name: 'Shared session' };
        const ciphertext = await writer.getSessionEncryption(sessionId)!.encryptRaw(metadata);
        const envelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionKey,
            recipientPublicKey: encryption.contentDataKey,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
        }]);
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({
            encryption,
            hydrateSessionById,
            applySessions: (sessions) => storage.getState().applySessions(sessions),
        });
        const updateData = {
            id: 'socket_pending_update', seq: 2, createdAt: 2,
            body: {
                t: 'new-session', id: sessionId, seq: 2,
                metadata: ciphertext, metadataVersion: 2,
                agentState: null, agentStateVersion: 0,
                encryptionMode: 'e2ee', dataEncryptionKey: null,
                active: true, activeAt: 2, createdAt: 1, updatedAt: 2,
            },
        } satisfies ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(hydrateSessionById).toHaveBeenCalledWith(sessionId, 'socket-update-missing-session');
        expect(encryption.getSessionEncryption(sessionId)).toBeNull();
        expect(storage.getState().sessions[sessionId]?.encryptedContentAvailability).toBe('encrypted_access_pending');

        await handleUpdateContainer({
            ...params,
            updateData: {
                ...updateData,
                body: { ...updateData.body, dataEncryptionKey: encodeBase64(envelope, 'base64') },
            },
        });

        expect(storage.getState().sessions[sessionId]).toMatchObject({
            metadata,
            encryptedContentAvailability: 'ready',
        });
        await expect(encryption.getSessionEncryption(sessionId)!.decryptRaw(ciphertext)).resolves.toEqual(metadata);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('applies self-sufficient new-session socket updates without full list invalidation', async () => {
        markSessionSurfaceVisible('s_new');
        const saveChangesCursorSpy = vi.spyOn(persistence, 'saveChangesCursor');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { sealEncryptedDataKeyEnvelopeV1} = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
        const encryption = runtime.encryption;
        if (!encryption) throw new Error('Expected the restored E2EE Account cipher');
        const writer = await Encryption.create(new Uint8Array(32).fill(7));
        const sessionDataKey = new Uint8Array(32).fill(8);
        await writer.initializeSessions(new Map([['s_new', sessionDataKey]]));
        const metadata = {
            name: 'Wave 11 created elsewhere',
            path: '/repo',
            homeDir: '/home/tester',
            host: 'tester-host',
            machineId: 'machine_1',
            flavor: 'codex',
        };
        const metadataCiphertext = await writer.getSessionEncryption('s_new')!.encryptRaw(metadata);
        const agentStateCiphertext = await writer.getSessionEncryption('s_new')!.encryptRaw({});
        const envelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionDataKey,
            recipientPublicKey: encryption.contentDataKey,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const detail = createDeferred<Response>();
        heldSessionDetail = detail.promise;
        const updateData: ApiUpdateContainer = {
            id: 'u1',
            seq: 10,
            createdAt: 100,
            body: {
                t: 'new-session',
                id: 's_new',
                seq: 1,
                metadata: metadataCiphertext,
                metadataVersion: 2,
                agentState: agentStateCiphertext,
                agentStateVersion: 3,
                dataEncryptionKey: encodeBase64(envelope, 'base64'),
                encryptionMode: 'e2ee',
                active: true,
                activeAt: 100,
                createdAt: 90,
                updatedAt: 100,
                meaningfulActivityAt: 95,
            },
        } satisfies ApiUpdateContainer;

        const { t: _type, ...record } = updateData.body;
        const detailResponse = Response.json({ session: V2SessionRecordSchema.parse({
            ...record, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        }) });
        const socketOwner = runtime as unknown as { handleUpdate(update: unknown): Promise<void> };
        try {
            await socketOwner.handleUpdate(updateData);

            const appliedSession = storage.getState().sessions.s_new;
            expect(appliedSession).toMatchObject({
                id: 's_new',
                seq: 1,
                encryptionMode: 'e2ee',
                createdAt: 90,
                updatedAt: 100,
                meaningfulActivityAt: 95,
                active: true,
                activeAt: 100,
                metadataVersion: 2,
                agentStateVersion: 3,
            });
            // Durable active/activeAt cannot manufacture device-observed runtime presence.
            expect(appliedSession?.presence).toBeUndefined();
            expect(appliedSession?.metadata?.name).toBe('Wave 11 created elsewhere');
            await expect(encryption.getSessionEncryption('s_new')!.decryptRaw(metadataCiphertext)).resolves.toEqual(metadata);
            await vi.waitFor(() => expect(sessionRequests).toContain('/v2/sessions/s_new'));
            expect(sessionRequests.filter((path) => path !== '/v2/sessions/s_new'
                && !path.startsWith('/v2/sessions/s_new/'))).toEqual([]);
            expect(saveChangesCursorSpy).not.toHaveBeenCalled();
        } finally {
            detail.resolve(detailResponse);
        }
    });

    it('falls back to targeted hydration when a new-session socket payload cannot be decrypted', async () => {
        markSessionSurfaceVisible('s_decrypt_fail');
        const hydrateSessionById = vi.fn();
        const applySessions = vi.fn<Parameters<typeof handleUpdateContainer>[0]['applySessions']>();
        const params = buildBaseParams({
            applySessions,
            hydrateSessionById,
        });
        // A malformed envelope arriving from the network exercises the real crypto refusal.
        const updateData: ApiUpdateContainer = {
            id: 'u1b',
            seq: 11,
            createdAt: 101,
            body: {
                t: 'new-session',
                id: 's_decrypt_fail',
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 2,
                agentState: 'encrypted-agent-state',
                agentStateVersion: 3,
                dataEncryptionKey: 'encrypted-data-key',
                encryptionMode: 'e2ee',
                active: true,
                activeAt: 101,
                createdAt: 90,
                updatedAt: 101,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(applySessions).not.toHaveBeenCalled();
        expect(hydrateSessionById).toHaveBeenCalledWith('s_decrypt_fail', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('falls back to targeted hydration using sid when a new-session socket payload has no id', async () => {
        markSessionSurfaceVisible('s_sid_only_decrypt_fail');
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({
            hydrateSessionById,
        });
        const updateData: ApiUpdateContainer = {
            id: 'u1c',
            seq: 12,
            createdAt: 102,
            body: {
                t: 'new-session',
                sid: 's_sid_only_decrypt_fail',
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 2,
                agentState: 'encrypted-agent-state',
                agentStateVersion: 3,
                dataEncryptionKey: 'encrypted-data-key',
                encryptionMode: 'e2ee',
            },
        } as unknown as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_sid_only_decrypt_fail', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('does not persist durable changes cursor when applying pending-changed socket updates', async () => {
        const sessionId = 's1';
        storage.getState().applySessions([buildSession(sessionId)]);
        const saveChangesCursorSpy = vi.spyOn(persistence, 'saveChangesCursor');
        const applySessions = vi.fn();
        const params = buildBaseParams({ applySessions });
        const updateData: ApiUpdateContainer = {
            id: 'u2',
            seq: 11,
            createdAt: 101,
            body: {
                t: 'pending-changed',
                sid: sessionId,
                pendingCount: 3,
                pendingVersion: 42,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(applySessions).toHaveBeenCalledTimes(1);
        const updatedSession = applySessions.mock.calls[0]?.[0]?.[0] as Session & {
            pendingCount?: number;
            pendingVersion?: number;
        };
        expect(updatedSession?.pendingCount).toBe(3);
        expect(updatedSession?.pendingVersion).toBe(42);
        expect(saveChangesCursorSpy).not.toHaveBeenCalled();
    });

    it('ignores stale activity thinking=true updates after lifecycle clear', () => {
        const sessionId = 's_stale_activity';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            thinking: false,
            thinkingAt: 200,
            updatedAt: 200,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 150, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('ignores stale activity thinking=true updates when activeAt equals updatedAt (prevents resurrecting cleared sessions)', () => {
        const sessionId = 's_equal_activeAt';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            thinking: false,
            thinkingAt: 150,
            updatedAt: 150,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 150, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('does not let newer legacy activity thinking override a terminal turn projection', () => {
        const sessionId = 's_terminal_activity';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            thinking: false,
            thinkingAt: 200,
            updatedAt: 200,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 200,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 300, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        // Liveness advances at its observation owner without republishing unchanged
        // terminal Session content for a healthy timestamp-only heartbeat.
        expect(applySessions).not.toHaveBeenCalled();
        const address = normalizeSessionAddress(getActiveServerSnapshot().serverId, sessionId)!;
        expect(sessionRuntimeObservations.read(address)?.activeAt).toBe(300);
        const updatedSession = storage.getState().sessions[sessionId]!;
        expect(updatedSession.thinking).toBe(false);
        expect(updatedSession.latestTurnStatus).toBe('completed');
    });

    it('applies activity active=false updates even if activeAt < updatedAt', async () => {
        const sessionId = 's_inactive_turnoff';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            active: true,
            activeAt: 100,
            updatedAt: 200,
            thinking: false,
            thinkingAt: 200,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: false, activeAt: 150, thinking: false }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        const updatedSession = applySessions.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession.active).toBe(false);
        expect(updatedSession.activeAt).toBe(150);
        expect(updatedSession.thinking).toBe(false);
        expect(updatedSession.thinkingAt).toBe(150);
    });

    it('patches list-only session rows from activity updates', async () => {
        vi.useFakeTimers();
        const sessionId = 's_renderable_only';
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(serverId).toBeTruthy();
        const row = buildSessionListRenderableFromSession({
            ...buildSession(sessionId),
            active: true,
            activeAt: 100,
            thinking: false,
            thinkingAt: 0,
        });
        storage.setState({
            sessions: {},
            sessionMessages: {},
            sessionPending: {},
            sessionListRowsByServerId: { [serverId]: { [sessionId]: row } },
            ordinarySessionListMembershipByServerId: { [serverId]: [sessionId] },
            isDataReady: true,
        } as never);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 200, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        expect(applySessions).not.toHaveBeenCalled();
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toMatchObject({
            active: true,
            activeAt: 100,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        await vi.advanceTimersByTimeAsync(16);

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toMatchObject({
            active: true,
            activeAt: 200,
            thinking: true,
            thinkingAt: 200,
            presence: 'online',
        });
    });
});
