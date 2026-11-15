import { socketApplyFrame } from '@/sync/engine/sessions/socketApplyFrame';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
    retainVisibleSessionListSurfaces,
    setRouteAnchorSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { fetchAndApplySessionById } from '@/sync/engine/sessions/sessionById';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { SessionEncryption, type AgentStateOpenResult } from '@/sync/encryption/sessionEncryption';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { SecretBoxEncryption, type Decryptor, type Encryptor } from '@/sync/encryption/encryptor';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushActivityUpdates, handleSocketUpdate, handleUpdateContainer } from './socket';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { projectUiSessionRuntimeAwareness } from '@/sync/domains/session/attention/runtimePresentation';
import { SESSION_LIST_DOCUMENT_ADMISSION } from '@/sync/domains/session/sessionDocumentAdmission';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { SESSION_OWNER_METADATA_PROJECTION } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { projectSessionLayout1OwnerMetadata, readSessionLayout1OwnerMetadata } from '@/sync/engine/sessions/readSessionLayout1OwnerProjection';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

const socketPostDecryptSideEffectMocks = vi.hoisted(() => ({
    notifyActivityAgentRequest: vi.fn(),
    reportNewAgentRequestsFromSessionTransition: vi.fn(),
}));

vi.mock('@/activity/notifications/runtime/activityLocalNotificationBus', () => ({
    notifyActivityAgentRequest: socketPostDecryptSideEffectMocks.notifyActivityAgentRequest,
}));

vi.mock('@/voice/context/reportNewAgentRequestsFromSessionTransition', () => ({
    reportNewAgentRequestsFromSessionTransition:
        socketPostDecryptSideEffectMocks.reportNewAgentRequestsFromSessionTransition,
}));

const initialStorageState = storage.getInitialState();

beforeEach(async () => { await selectActiveTestHomeForTests(); });

function replaceActiveSessionListRows(rows: SessionListRenderableSession[]): void {
    const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!serverId) throw new Error('Expected an active Home for the socket fixture.');
    storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' });
}

function demandSessionListRow(sessionId: string): void {
    const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
    retainVisibleSessionListSurfaces([{ serverId, sessionId }]);
}
type HandleUpdateContainerParams = Parameters<typeof handleUpdateContainer>[0];
type HandleUpdateContainerBaseParams = Omit<HandleUpdateContainerParams, 'updateData'>;

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function buildSession(sessionId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        encryptionMode: 'plain',
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/tmp', host: 'localhost' },
        metadataVersion: 1,
        agentState: {},
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildBaseParams(overrides: Partial<HandleUpdateContainerBaseParams> = {}): HandleUpdateContainerBaseParams {
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as HandleUpdateContainerBaseParams['encryption'],
        artifactDataKeys: new Map(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        hydrateSessionById: vi.fn(),
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
        onTaskLifecycleEvent: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket update handling: plaintext update-session', () => {
    it('publishes a streamed Session once per frame when every socket update brings its own apply callback', async () => {
        vi.useFakeTimers();
        try {
            const session = buildSession('s_frame_per_update_handler');
            storage.getState().applySessions([session]);
            markSessionSurfaceVisible(session.id);
            let publishes = 0;
            const unsubscribe = storage.subscribe((state, previous) => {
                if (state.sessions[session.id] !== previous.sessions[session.id]) publishes += 1;
            });
            try {
                for (const seq of [2, 3, 4]) {
                    // The Sync wiring builds a fresh callback per update (it records that update's observation).
                    const params = buildBaseParams({ applySessions: (rows) => storage.getState().applySessions(rows) });
                    await handleSocketUpdate({ ...params, update: { id: `streamed-${seq}`, seq, createdAt: seq * 100,
                        body: { t: 'update-session', id: session.id, active: true, activeAt: seq * 100 } } });
                }
                expect(publishes).toBe(0);
                await vi.advanceTimersByTimeAsync(16);
                expect(publishes).toBe(1);
                expect(storage.getState().sessions[session.id].activeAt).toBe(400);
            } finally {
                unsubscribe();
            }
        } finally {
            socketApplyFrame.flushNow();
            vi.useRealTimers();
        }
    });

    it.each(['permission request', 'turn end'] as const)('applies a %s at once instead of holding it for the streaming frame', async (boundary) => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(10_000);
            const session = {
                ...buildSession(`s_frame_boundary_${boundary.replace(' ', '_')}`),
                thinking: true, thinkingAt: 100, latestReadyEventSeq: 1, latestReadyEventAt: 100,
            };
            storage.getState().applySessions([session]);
            markSessionSurfaceVisible(session.id);
            const params = buildBaseParams({ applySessions: (rows) => storage.getState().applySessions(rows) });
            // A streamed update that only needs to reach the screen with its frame.
            await handleSocketUpdate({ ...params, update: { id: 'streamed', seq: 2, createdAt: 200,
                body: { t: 'update-session', id: session.id, active: true, activeAt: 200 } } });
            await handleSocketUpdate({ ...params, update: { id: 'boundary', seq: 3, createdAt: 300,
                body: boundary === 'permission request'
                    ? { t: 'update-session', id: session.id, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
                        pendingRequestObservedAt: 300,
                        agentState: { version: 2, value: JSON.stringify({ requests: { r1: {
                            tool: 'Bash', kind: 'permission', arguments: { command: 'ls' }, createdAt: 299,
                        } } }) } }
                    : { t: 'update-session', id: session.id, active: true, activeAt: 300, thinking: false, thinkingAt: 300,
                        latestReadyEventSeq: 2, latestReadyEventAt: 300 } } });

            // No frame has run: the boundary and the update queued before it are both already applied.
            const applied = storage.getState().sessions[session.id];
            expect(applied.activeAt).toBe(boundary === 'permission request' ? 200 : 300);
            if (boundary === 'permission request') {
                expect(Object.keys(applied.agentState?.requests ?? {})).toEqual(['r1']);
            } else {
                expect(applied.latestReadyEventSeq).toBe(2);
            }
        } finally {
            socketApplyFrame.flushNow();
            vi.useRealTimers();
        }
    });

    it.each([false, true])('observes omitted metadata without opening it or refreshing the list and retains Agent-state request delivery (full consumer: %s)', async (fullConsumer) => {
        const session = { ...buildSession('metadata-hint'), pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0, [SESSION_LIST_DOCUMENT_ADMISSION]: {
                scope: 'test', encryptionMode: 'plain' as const, metadataLayoutVersion: 0,
                dataEncryptionKey: null, metadataAudience: 'owner' as const, openedMetadataVersion: 1,
                observedMetadataVersion: 1, openedAgentStateVersion: 1,
            } };
        storage.getState().applySessions([session]);
        if (fullConsumer) markSessionSurfaceVisible(session.id);
        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({ applySessions: sessions => storage.getState().applySessions(sessions),
            markSessionStateHydrationDeferred });
        await handleSocketUpdate({ ...params, update: { id: 'metadata-hint', seq: 2, createdAt: 200,
            body: { t: 'update-session', id: session.id, metadataDocument: 'omitted', metadataLayoutVersion: 0,
                metadataVersion: 2, active: true, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
                agentState: { version: 2, value: JSON.stringify({ requests: { request: {
                    tool: 'Bash', kind: 'permission', arguments: { command: 'git status' }, createdAt: 199,
                } } }) } },
        } });
        const next = storage.getState().sessions[session.id];
        expect(next.metadata).toEqual(session.metadata);
        expect(next.metadataVersion).toBe(1);
        expect(next[SESSION_LIST_DOCUMENT_ADMISSION]).toMatchObject({ openedMetadataVersion: 1, observedMetadataVersion: 2 });
        expect(next.metadataLayoutVersion ?? 0).toBe(0);
        expect(next[SESSION_LIST_DOCUMENT_ADMISSION]?.observedMetadataLayoutVersion).toBe(0);
        expect(hasAuthoritativeSessionRouteData(next)).toBe(false);
        expect(next.agentState?.requests?.request.tool).toBe('Bash');
        expect(next.pendingPermissionRequestCount).toBe(1);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith(session.id);
        if (fullConsumer) {
            expect(params.hydrateSessionById).toHaveBeenCalledExactlyOnceWith(session.id, 'socket-update-owner-metadata');
        } else {
            expect(params.hydrateSessionById).not.toHaveBeenCalled();
        }
    });

    it('records an omitted layout transition even when its numeric metadata revision resets', async () => {
        const session = { ...buildSession('metadata-layout-hint'), metadataVersion: 99,
            [SESSION_LIST_DOCUMENT_ADMISSION]: { scope: 'test', encryptionMode: 'plain' as const,
                metadataLayoutVersion: 0, metadataAudience: 'owner' as const, dataEncryptionKey: null,
                openedMetadataVersion: 99, observedMetadataVersion: 99, openedAgentStateVersion: 1 } };
        storage.getState().applySessions([session]);
        const params = buildBaseParams({ applySessions: rows => storage.getState().applySessions(rows) });
        await handleSocketUpdate({ ...params, update: { id: 'layout-hint', seq: 2, createdAt: 2,
            body: { t: 'update-session', id: session.id, metadataDocument: 'omitted', metadataLayoutVersion: 1, metadataVersion: 1 } } });
        socketApplyFrame.flushNow();
        const next = storage.getState().sessions[session.id];
        expect(next.metadataVersion).toBe(99);
        expect(next.metadataLayoutVersion ?? 0).toBe(0);
        expect(next[SESSION_LIST_DOCUMENT_ADMISSION]).toMatchObject({ openedMetadataVersion: 99,
            observedMetadataVersion: 1, observedMetadataLayoutVersion: 1 });
        expect(hasAuthoritativeSessionRouteData(next)).toBe(false);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect(params.hydrateSessionById).not.toHaveBeenCalled();
    });

    it.each(['hidden', 'list-row', 'full-consumer'] as const)('applies a metadata-only omitted observation with targeted hydration only for an active cache-only anchor (%s)', async (anchor) => {
        vi.useFakeTimers();
        const id = 'cached-metadata-hint';
        const serverId = String(getActiveServerSnapshot().serverId);
        replaceActiveSessionListRows([{ ...buildSession(id), hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false, [SESSION_LIST_DOCUMENT_ADMISSION]: {
                scope: 'test', encryptionMode: 'plain', metadataLayoutVersion: 0, metadataAudience: 'owner',
                dataEncryptionKey: null, openedMetadataVersion: 1, observedMetadataVersion: 1,
            } }]);
        if (anchor === 'list-row') demandSessionListRow(id);
        if (anchor === 'full-consumer') markSessionSurfaceVisible(id, serverId);
        const params = buildBaseParams({ sourceServerId: serverId });
        await handleSocketUpdate({ ...params, update: { id: 'cached-metadata-hint', seq: 2, createdAt: 2,
            body: { t: 'update-session', id, metadataDocument: 'omitted', metadataLayoutVersion: 0, metadataVersion: 2 } } });
        expect(storage.getState().sessionListRowsByServerId[serverId][id][SESSION_LIST_DOCUMENT_ADMISSION])
            .toMatchObject({ openedMetadataVersion: 1, observedMetadataVersion: 1 });
        await vi.advanceTimersByTimeAsync(loadSyncTuning().activityUpdateDebounceMs);
        const row = storage.getState().sessionListRowsByServerId[serverId][id];
        expect(row.hasPendingPermissionRequests).toBe(false);
        expect(row.metadataVersion).toBe(1);
        expect(row[SESSION_LIST_DOCUMENT_ADMISSION]).toMatchObject({ openedMetadataVersion: 1, observedMetadataVersion: 2 });
        if (anchor !== 'hidden') {
            expect(params.hydrateSessionById).toHaveBeenCalledExactlyOnceWith(id, 'socket-update-owner-metadata');
        } else {
            expect(params.hydrateSessionById).not.toHaveBeenCalled();
        }
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('rejects prior-layout public pending counts after a cached privacy contraction', async () => {
        vi.useFakeTimers();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const session = { ...buildSession('s_cached_privacy_contraction'), serverId, encryptionMode: 'e2ee' as const,
            metadataLayoutVersion: 1, metadata: null, agentStateVersion: 1, archivedAt: null,
            hasPendingPermissionRequests: false, hasPendingUserActionRequests: false, pendingRequestObservedAt: null };
        replaceActiveSessionListRows([session]);
        await handleUpdateContainer({ ...buildBaseParams(), sourceServerId: serverId, updateData: {
            id: 'prior-layout-public-pending', seq: 8, createdAt: 200,
            body: { t: 'update-session', id: session.id, metadataLayoutVersion: 0,
                agentState: { version: 8, value: 'prior-layout-ciphertext' },
                pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: 100 },
        } });
        await vi.advanceTimersByTimeAsync(100);
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id]).toMatchObject({
            metadataLayoutVersion: 1, agentStateVersion: 1, hasPendingPermissionRequests: false,
            pendingRequestObservedAt: null,
        });
    });

    it('rejects delayed prior-layout private Agent state after a privacy contraction resets versions', async () => {
        vi.useFakeTimers();
        const sessionId = 's_delayed_privacy_contraction';
        const initial = { ...buildSession(sessionId), encryptionMode: 'e2ee' as const,
            metadataLayoutVersion: 0, agentStateVersion: 7,
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null };
        storage.getState().applySessions([initial]);
        markSessionSurfaceVisible(sessionId);
        const decryptStarted = createDeferred<void>();
        const releaseDecrypt = createDeferred<void>();
        const crypto = new SecretBoxEncryption(new Uint8Array(32));
        // Delay only the platform crypto boundary; Session parsing and admission remain real.
        const delayedCrypto: Encryptor & Decryptor = {
            encrypt: data => crypto.encrypt(data),
            decrypt: async (data, options) => {
                decryptStarted.resolve();
                await releaseDecrypt.promise;
                return crypto.decrypt(data, options);
            },
        };
        const sessionEncryption = new SessionEncryption(sessionId, delayedCrypto, new EncryptionCache());
        const params = buildBaseParams({ encryption: {
            getSessionEncryption: () => sessionEncryption, getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as HandleUpdateContainerBaseParams['encryption'],
        applySessions: rows => storage.getState().applySessions(rows) });
        const oldCiphertext = await sessionEncryption.encryptAgentState({ requests: {
            privateRequest: { tool: 'Bash', arguments: { secret: 'private-agent-state' }, createdAt: 100 },
        } });
        let older: Promise<void> | undefined;
        try {
            older = handleUpdateContainer({ ...params, updateData: {
                id: 'prior-layout-agent-state', seq: 8, createdAt: 200,
                body: { t: 'update-session', id: sessionId,
                    agentState: { version: 8, value: oldCiphertext }, pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0, pendingRequestObservedAt: 100 },
            } });
            await decryptStarted.promise;
            storage.getState().applySessions([{ ...initial, metadataLayoutVersion: 1,
                metadata: null, metadataVersion: 1, ownerMetadataView: null,
                accessLevel: 'view', agentState: null, agentStateVersion: 1 }]);
            expect(storage.getState().sessions[sessionId]).toMatchObject({ metadataLayoutVersion: 1, agentStateVersion: 1 });
            releaseDecrypt.resolve();
            await older;
            await vi.advanceTimersByTimeAsync(100);
            expect(storage.getState().sessions[sessionId]).toMatchObject({
                metadataLayoutVersion: 1, agentStateVersion: 1, agentState: null,
                pendingPermissionRequestCount: 0, pendingRequestObservedAt: null,
            });
            expect(JSON.stringify(storage.getState().sessions[sessionId])).not.toContain('private-agent-state');
        } finally {
            releaseDecrypt.resolve();
            await older;
        }
    });

    it('does not resurrect stopped owner metadata or presence when an Agent state decrypt finishes later', async () => {
        vi.useFakeTimers();
        const sessionId = 's_delayed_agent_state_after_stop';
        const initial: Session = { ...buildSession(sessionId), encryptionMode: 'e2ee',
            metadataLayoutVersion: 1, metadataVersion: 36, agentStateVersion: 7,
            access: createSessionAccessFixture(), encryptedContentAvailability: 'ready',
            ownerMetadataView: { path: '/tmp', host: 'localhost', lifecycleState: 'running' } };
        storage.getState().applySessions([initial]);
        markSessionSurfaceVisible(sessionId);
        const decryptStarted = createDeferred<void>();
        const releaseDecrypt = createDeferred<void>();
        const crypto = new SecretBoxEncryption(new Uint8Array(32));
        // Only crypto is delayed: the socket admission and Session store stay real.
        const delayedCrypto: Encryptor & Decryptor = {
            encrypt: data => crypto.encrypt(data),
            decrypt: async (data, options) => {
                decryptStarted.resolve();
                await releaseDecrypt.promise;
                return crypto.decrypt(data, options);
            },
        };
        const sessionEncryption = new SessionEncryption(sessionId, delayedCrypto, new EncryptionCache());
        const params = buildBaseParams({ encryption: {
            getSessionEncryption: () => sessionEncryption, getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as HandleUpdateContainerBaseParams['encryption'],
        applySessions: rows => storage.getState().applySessions(rows) });
        const ciphertext = await sessionEncryption.encryptAgentState({ requests: {} });
        let pending: Promise<void> | undefined;
        try {
            pending = handleUpdateContainer({ ...params, updateData: {
                id: 'delayed-agent-state-after-stop', seq: 8, createdAt: 200,
                body: { t: 'update-session', id: sessionId, metadataLayoutVersion: 1,
                    agentState: { version: 8, value: ciphertext } },
            } });
            await decryptStarted.promise;
            // The layout-1 owner envelope can refresh at the same shared metadata revision.
            // Publisher closure also leaves activeAt unchanged.
            storage.getState().applySessions([{ ...initial, active: false, updatedAt: 300,
                ownerMetadataView: { ...initial.ownerMetadataView!, lifecycleState: 'stopped' } }]);
            releaseDecrypt.resolve();
            await pending;
            await vi.advanceTimersByTimeAsync(100);
            expect(storage.getState().sessions[sessionId]).toMatchObject({
                active: false, metadataVersion: 36,
                ownerMetadataView: { lifecycleState: 'stopped' },
                agentStateVersion: 8, agentState: { requests: {} },
            });
        } finally {
            releaseDecrypt.resolve();
            await pending;
        }
    });

    it('does not resurrect cached presence when metadata decrypt finishes after a Stop refresh', async () => {
        vi.useFakeTimers();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const initial = { ...buildSession('s_cached_decrypt_after_stop'), serverId,
            encryptionMode: 'e2ee' as const, archivedAt: null };
        replaceActiveSessionListRows([initial]);
        demandSessionListRow(initial.id);
        const decryptStarted = createDeferred<void>();
        const releaseDecrypt = createDeferred<void>();
        const crypto = new SecretBoxEncryption(new Uint8Array(32));
        const reader = new SessionEncryption(initial.id, {
            encrypt: data => crypto.encrypt(data),
            decrypt: async (data, options) => {
                decryptStarted.resolve();
                await releaseDecrypt.promise;
                return crypto.decrypt(data, options);
            },
        }, new EncryptionCache());
        const params = buildBaseParams({ encryption: {
            getSessionEncryption: () => reader, getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as HandleUpdateContainerBaseParams['encryption'] });
        const ciphertext = await reader.encryptMetadata({ path: '/tmp', host: 'localhost', lifecycleState: 'running' });
        let pending: Promise<void> | undefined;
        try {
            pending = handleUpdateContainer({ ...params, sourceServerId: serverId, updateData: {
                id: 'cached-metadata-after-stop', seq: 8, createdAt: 200,
                body: { t: 'update-session', id: initial.id, metadata: { version: 2, value: ciphertext } },
            } });
            await decryptStarted.promise;
            replaceActiveSessionListRows([{ ...initial, active: false, metadataVersion: 3, updatedAt: 300,
                metadata: { path: '/tmp', host: 'localhost', lifecycleState: 'stopped' } }]);
            releaseDecrypt.resolve();
            await pending;
            expect(storage.getState().sessionListRowsByServerId[serverId][initial.id]).toMatchObject({
                active: false, metadataVersion: 3, metadata: { lifecycleState: 'stopped' },
            });
            expect(storage.getState().sessions[initial.id]).toBeUndefined();
        } finally {
            releaseDecrypt.resolve();
            await pending;
        }
    });

    it.each(['cache-only', 'missing-key', 'hidden'] as const)('keeps public request freshness through %s updates without promoting detail state', async (mode) => {
        vi.useFakeTimers();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const session = { ...buildSession(`s_public_request_${mode}`), serverId, encryptionMode: mode === 'hidden' ? 'plain' as const : 'e2ee' as const,
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null };
        if (mode === 'cache-only') replaceActiveSessionListRows([{ ...session, archivedAt: null,
            hasPendingPermissionRequests: false, hasPendingUserActionRequests: false }]);
        else storage.getState().applySessions([session]);
        const params = buildBaseParams({ applySessions: rows => storage.getState().applySessions(rows) });
        for (const [version, count, observedAt, createdAt] of [[3, 0, null, 300], [2, 1, 100, 400]] as const) {
            await handleUpdateContainer({ ...params, sourceServerId: serverId, updateData: {
                id: `public-request-${version}`, seq: version + 1, createdAt,
                body: { t: 'update-session', id: session.id, agentState: { version, value: mode === 'hidden'
                    ? JSON.stringify({ requests: count === 0 ? {} : { r1: { tool: 'Bash', arguments: {}, createdAt: 100 } } })
                    : 'unavailable-ciphertext' },
                    pendingPermissionRequestCount: count, pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: observedAt },
            } });
            if (mode !== 'hidden' || version === 2) await vi.advanceTimersByTimeAsync(100);
        }
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id]).toMatchObject({
            agentStateVersion: 3, hasPendingPermissionRequests: false, hasPendingUserActionRequests: false,
            pendingRequestObservedAt: null,
        });
        if (mode !== 'cache-only') expect(storage.getState().sessions[session.id]).toMatchObject({
            agentStateVersion: 1, pendingPermissionRequestCount: 0, pendingRequestObservedAt: null,
        });
    });

    it('keeps a settled request cohort when an older request state arrives after approval', async () => {
        vi.useFakeTimers();
        const sessionId = 's_settled_request';
        storage.getState().applySessions([buildSession(sessionId)]);
        markSessionSurfaceVisible(sessionId);
        const params = buildBaseParams({ applySessions: rows => storage.getState().applySessions(rows) });
        for (const [version, count, observedAt, createdAt] of [[3, 0, null, 300], [2, 1, 100, 400]] as const) {
            await handleUpdateContainer({
                ...params,
                updateData: {
                    id: `request-version-${version}`, seq: version + 1, createdAt,
                    body: { t: 'update-session', id: sessionId,
                        agentState: { version, value: JSON.stringify({ requests: count === 0 ? {} : {
                            r1: { tool: 'Bash', arguments: {}, createdAt: 100 },
                        } }) },
                        pendingPermissionRequestCount: count, pendingUserActionRequestCount: 0,
                        pendingRequestObservedAt: observedAt },
                },
            });
            await vi.advanceTimersByTimeAsync(100);
        }
        expect(storage.getState().sessions[sessionId]).toMatchObject({
            agentStateVersion: 3, agentState: { requests: {} },
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null,
        });
    });
    beforeEach(() => {
        sessionRuntimeObservations.clear();
        storage.setState(initialStorageState, true);
        resetSessionSurfaceVisibilityForTests();
        socketPostDecryptSideEffectMocks.notifyActivityAgentRequest.mockClear();
        socketPostDecryptSideEffectMocks.reportNewAgentRequestsFromSessionTransition.mockClear();
    });

    it.each(['retained', 'cache-only'] as const)('preserves completion through delayed HTTP hydration of a %s session', async (mode) => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const session = { ...buildSession('s_delayed_completion'), serverId,
            updatedAt: 100, activeAt: 100, thinking: true, thinkingAt: 100,
            latestTurnId: 'turn-1', latestTurnStatus: 'in_progress' as const, latestTurnStatusObservedAt: 100,
            latestReadyEventSeq: 1, latestReadyEventAt: 100,
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: 100 };
        if (mode === 'retained') storage.getState().applySessions([session]);
        else replaceActiveSessionListRows([{ ...session, archivedAt: null }]);
        const snapshot = createDeferred<void>();
        const applySessions = (rows: Parameters<ReturnType<typeof storage.getState>['applySessions']>[0]) => storage.getState().applySessions(rows);
        const hydration = fetchAndApplySessionById({
            sessionId: session.id, serverId, credentials: { token: 'test-token' },
            accountCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 },
            encryption: { decryptEncryptionKey: async () => null, initializeSessions: async () => {}, getSessionEncryption: () => null },
            sessionDataKeys: new Map(), includeTurnsProjection: false,
            request: async () => {
                await snapshot.promise;
                return Response.json({ session: { ...session, dataEncryptionKey: null, share: null,
                    metadataLayoutVersion: 0, metadataVersion: 2,
                    metadata: JSON.stringify({ path: '/tmp/new', host: 'localhost' }), agentState: JSON.stringify({}) } });
            },
            applySessions, getExistingSession: (id) => storage.getState().sessions[id], log: { log: () => {} },
        });
        await handleUpdateContainer({ ...buildBaseParams(), applySessions, sourceServerId: serverId, updateData: {
            id: 'completion', seq: 2, createdAt: 200,
            body: { t: 'update-session', id: session.id, active: true, activeAt: 200,
                thinking: false, thinkingAt: 200, latestTurnId: 'turn-1', latestTurnStatus: 'completed', latestTurnStatusObservedAt: 200,
                latestReadyEventSeq: 2, latestReadyEventAt: 200,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: 200 },
        } });
        await vi.advanceTimersByTimeAsync(16);
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id].latestTurnStatus).toBe('completed');
        const completedPending = {
            hasPendingPermissionRequests: storage.getState().sessionListRowsByServerId[serverId][session.id].hasPendingPermissionRequests,
            pendingRequestObservedAt: storage.getState().sessionListRowsByServerId[serverId][session.id].pendingRequestObservedAt,
        };
        snapshot.resolve();
        // The HTTP response schedules hydration publication after the earlier socket flush.
        // waitFor advances the fake clock while observing the real publication boundary.
        await vi.waitFor(() => expect(storage.getState().sessions[session.id]?.metadata?.path).toBe('/tmp/new'));
        expect((await hydration).ok).toBe(true);
        expect(storage.getState().sessions[session.id]).toMatchObject({ active: true, pendingPermissionRequestCount: mode === 'retained' ? 0 : 1, pendingRequestObservedAt: mode === 'retained' ? 200 : 100 });
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id]).toMatchObject(completedPending);
        expect(storage.getState().sessions[session.id]).toMatchObject({ latestTurnStatus: 'completed', latestReadyEventSeq: 2, latestReadyEventAt: 200 });
        expect(storage.getState().sessions[session.id].metadata?.path).toBe('/tmp/new');
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id]).toMatchObject({ latestTurnStatus: 'completed', latestReadyEventSeq: 2, latestReadyEventAt: 200 });
    });

    it('publishes a terminal-only cached transition without waiting for the activity window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const session = { ...buildSession('s_terminal_only'), serverId, updatedAt: 100, activeAt: 100,
            latestTurnId: 'turn-1', latestTurnStatus: 'in_progress' as const, latestTurnStatusObservedAt: 100,
            latestReadyEventSeq: 1, latestReadyEventAt: 100, hasUnreadMessages: true };
        replaceActiveSessionListRows([session]);
        await handleUpdateContainer({ ...buildBaseParams(), sourceServerId: serverId, updateData: {
            id: 'completion', seq: 2, createdAt: 200, body: { t: 'update-session', id: session.id,
                latestTurnStatus: 'completed', latestTurnStatusObservedAt: 200 },
        } });
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id].latestTurnStatus).toBe('completed');
    });

    it('applies working-to-online activity even when a newer durable projection advanced updatedAt', () => {
        const session = {
            ...buildSession('s_working_to_online'),
            updatedAt: 200,
            activeAt: 100,
            thinking: true,
            thinkingAt: 100,
        };
        storage.setState({
            ...initialStorageState,
            sessions: { [session.id]: session },
        });
        const applySessions = vi.fn();

        flushActivityUpdates({
            updates: new Map([[session.id, {
                type: 'activity',
                id: session.id,
                active: true,
                activeAt: 150,
                thinking: false,
            }]]),
            applySessions,
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: session.id,
                active: true,
                thinking: false,
                activeAt: 150,
            }),
        ]);
    });

    it('orders thinking resurrection against the full-publication witness', async () => {
        vi.useFakeTimers();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const session = { ...buildSession('full-publication-thinking'), serverId, updatedAt: 100, activeAt: 100 };
        storage.getState().applySessions([session]);
        const address = { serverId, sessionId: session.id };
        sessionRuntimeObservations.observe(address, { active: true, activeAt: 100, thinking: false, presence: 'online' });
        sessionRuntimeObservations.recordFullPublication(address, 300);
        for (const activeAt of [200, 301]) {
            flushActivityUpdates({ sourceServerId: serverId, applySessions: storage.getState().applySessions,
                updates: new Map([[session.id, { type: 'activity', id: session.id, active: true, activeAt, thinking: true }]]) });
            await vi.advanceTimersByTimeAsync(16);
            expect(storage.getState().sessions[session.id].thinking).toBe(activeAt > 300);
            expect(projectUiSessionRuntimeAwareness({ ...storage.getState().sessions[session.id], nowMs: 301 }).working)
                .toBe(activeAt > 300);
        }
    });

    it.each(['hydrated', 'cache-only'] as const)('does not resurrect %s working state from an equal-timestamp heartbeat after a stop', async (kind) => {
        vi.useFakeTimers();
        const session = {
            ...buildSession('s_delayed_working_heartbeat'),
            updatedAt: 200,
            activeAt: 100,
            thinking: true,
            thinkingAt: 100,
        };
        if (kind === 'hydrated') {
            storage.getState().applySessions([session]);
        } else {
            replaceActiveSessionListRows([{ ...session, archivedAt: null }]);
        }
        const readThinking = () => kind === 'hydrated'
            ? storage.getState().sessions[session.id].thinking
            : storage.getState().sessionListRowsByServerId[String(getActiveServerSnapshot().serverId)][session.id].thinking;
        const applySessions = storage.getState().applySessions;
        flushActivityUpdates({
            updates: new Map([[session.id, {
                type: 'activity', id: session.id, active: true, activeAt: 200, thinking: false,
            }]]),
            applySessions,
        });
        await vi.advanceTimersByTimeAsync(16);
        expect(readThinking()).toBe(false);

        flushActivityUpdates({
            updates: new Map([[session.id, {
                type: 'activity', id: session.id, active: true, activeAt: 200, thinking: true,
            }]]),
            applySessions,
        });
        await vi.advanceTimersByTimeAsync(16);
        expect(readThinking()).toBe(false);

        flushActivityUpdates({
            updates: new Map([[session.id, {
                type: 'activity', id: session.id, active: true, activeAt: 201, thinking: true,
            }]]),
            applySessions,
        });
        await vi.advanceTimersByTimeAsync(16);
        expect(readThinking()).toBe(true);
    });

    it('applies cache-only working-to-online activity after a newer durable projection', async () => {
        vi.useFakeTimers();
        const session = {
            ...buildSession('s_cached_working_to_online'),
            updatedAt: 200,
            activeAt: 100,
            thinking: true,
            thinkingAt: 100,
            archivedAt: null,
        };
        replaceActiveSessionListRows([session]);
        flushActivityUpdates({
            updates: new Map([[session.id, {
                type: 'activity', id: session.id, active: true, activeAt: 150, thinking: false,
            }]]),
            applySessions: storage.getState().applySessions,
        });
        await vi.advanceTimersByTimeAsync(16);
        expect(storage.getState().sessionListRowsByServerId[String(getActiveServerSnapshot().serverId)][session.id]).toMatchObject({
            active: true, activeAt: 150, thinking: false, thinkingAt: 150,
        });
    });

    it('rechecks a queued cache-only working heartbeat against a stop published before its flush', async () => {
        vi.useFakeTimers();
        const session = {
            ...buildSession('s_cached_queued_working'),
            updatedAt: 100,
            activeAt: 100,
            thinkingAt: 100,
            archivedAt: null,
        };
        replaceActiveSessionListRows([session]);
        flushActivityUpdates({
            updates: new Map([[session.id, {
                type: 'activity', id: session.id, active: true, activeAt: 200, thinking: true,
            }]]),
            applySessions: storage.getState().applySessions,
        });
        storage.getState().applyServerScopedSessionListRowPatches(String(getActiveServerSnapshot().serverId), [{
            sessionId: session.id,
            patch: { thinking: false, thinkingAt: 200, activeAt: 200, updatedAt: 200 },
        }]);
        await vi.advanceTimersByTimeAsync(16);
        expect(storage.getState().sessionListRowsByServerId[String(getActiveServerSnapshot().serverId)][session.id].thinking).toBe(false);
    });

    afterEach(() => {
        socketApplyFrame.flushNow();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        resetSessionSurfaceVisibilityForTests();
        vi.useRealTimers();
    });

    it('applies plaintext session updates when session encryption is unavailable', async () => {
        markSessionSurfaceVisible('s1');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([buildSession('s1')]);
            const params = buildBaseParams();
            const updateData: ApiUpdateContainer = {
                id: 'u_plain_session',
                seq: 10,
                createdAt: 1234,
                body: {
                    t: 'update-session',
                    id: 's1',
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
                    agentState: { version: 3, value: JSON.stringify({ controlledByUser: true }) },
                },
            };

            await handleUpdateContainer({
                ...params,
                updateData,
            });

            expect(consoleError).not.toHaveBeenCalled();
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession.metadata).toEqual({ path: '/work', host: 'devbox' });
            expect(updatedSession.metadataVersion).toBe(2);
            expect(updatedSession.agentState).toEqual({ controlledByUser: true });
            expect(updatedSession.agentStateVersion).toBe(3);
            expect(updatedSession.lastViewedSessionSeq).toBe(5);
            expect(updatedSession.pendingPermissionRequestCount).toBe(2);
            expect(updatedSession.pendingUserActionRequestCount).toBe(1);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('hydrates a serialized hidden Voice permission update into global Inbox custody', async () => {
        const sessionId = 's_hidden_voice_post_end_permission';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            serverId: 'server-a',
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            metadata: {
                path: '/tmp',
                host: 'localhost',
                systemSessionV1: {
                    v: 1,
                    key: 'voice_conversation',
                    hidden: true,
                },
                voiceConversationScopeV1: {
                    v: 1,
                    kind: 'voice_home',
                },
            },
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: {},
            },
        }]);
        const applySessions = vi.fn((sessions: Parameters<HandleUpdateContainerBaseParams['applySessions']>[0]) => {
            storage.getState().applySessions(sessions);
        });
        const params = buildBaseParams({ applySessions });
        const updateData = JSON.parse(JSON.stringify({
            id: 'u_hidden_voice_post_end_permission',
            seq: 10,
            createdAt: 1_234,
            body: {
                t: 'update-session',
                id: sessionId,
                pendingPermissionRequestCount: 1,
                agentState: {
                    version: 2,
                    value: JSON.stringify({
                        controlledByUser: null,
                        requests: {
                            'permission-after-end': {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git status' },
                                createdAt: 1_233,
                            },
                        },
                        completedRequests: {},
                    }),
                },
            },
        } satisfies ApiUpdateContainer)) as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        const hydratedSession = storage.getState().sessions[sessionId];
        expect(hydratedSession).toEqual(expect.objectContaining({
            id: sessionId,
            pendingPermissionRequestCount: 1,
            agentState: expect.objectContaining({
                requests: {
                    'permission-after-end': expect.objectContaining({
                        kind: 'permission',
                    }),
                },
            }),
        }));
        const inbox = buildInboxSessionPresentation({
            overview: buildActivityOverviewSnapshot({
                sessions: [hydratedSession!],
                nowMs: 1_234,
            }),
        });
        expect(inbox.sessionsNeedingAttention).toEqual([
            expect.objectContaining({
                candidate: expect.objectContaining({
                    session: expect.objectContaining({
                        id: sessionId,
                        metadata: expect.objectContaining({
                            systemSessionV1: {
                                v: 1,
                                key: 'voice_conversation',
                                hidden: true,
                            },
                            voiceConversationScopeV1: {
                                v: 1,
                                kind: 'voice_home',
                            },
                        }),
                    }),
                }),
                pendingPermissions: [
                    expect.objectContaining({
                        id: 'permission-after-end',
                        kind: 'permission',
                        tool: 'Bash',
                        arguments: { command: 'git status' },
                        createdAt: 1_233,
                    }),
                ],
            }),
        ]);
    });

    it('still applies projection fields for an e2ee session when session encryption is missing instead of dropping the update', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s_e2ee_missing_key'),
                encryptionMode: 'e2ee',
                agentState: { controlledByUser: false, requests: {} },
                agentStateVersion: 1,
                metadata: { path: '/tmp', host: 'localhost', name: 'Existing title' },
                metadataVersion: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 100,
            }]);
            // No session encryption available for this e2ee session.
            const params = buildBaseParams({
                encryption: {
                    getSessionEncryption: () => null,
                    getMachineEncryption: () => null,
                    removeSessionEncryption: () => {},
                } as unknown as HandleUpdateContainerBaseParams['encryption'],
            });

            await handleUpdateContainer({
                ...params,
                updateData: {
                    id: 'u_e2ee_missing_key',
                    seq: 12,
                    createdAt: 2_500,
                    body: {
                        t: 'update-session',
                        id: 's_e2ee_missing_key',
                        pendingPermissionRequestCount: 3,
                        pendingUserActionRequestCount: 1,
                        latestReadyEventSeq: 42,
                        latestReadyEventAt: 2_400,
                        latestTurnId: 'turn-9',
                        latestTurnStatus: 'completed',
                        latestTurnStatusObservedAt: 2_450,
                        meaningfulActivityAt: 2_450,
                        // Encrypted payloads we cannot decrypt without the missing key.
                        metadata: { version: 2, value: 'encrypted-metadata' },
                        agentState: { version: 2, value: 'encrypted-agent-state' },
                    },
                },
            });

            // The update must NOT be dropped: projection fields still apply.
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession).toEqual(expect.objectContaining({
                pendingPermissionRequestCount: 3,
                pendingUserActionRequestCount: 1,
                latestReadyEventSeq: 42,
                latestReadyEventAt: 2_400,
                latestTurnId: 'turn-9',
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 2_450,
                meaningfulActivityAt: 2_450,
                updatedAt: 2_500,
            }));
            // Encrypted state is left untouched (skip only the decrypt).
            expect(updatedSession.metadata).toEqual({ path: '/tmp', host: 'localhost', name: 'Existing title' });
            expect(updatedSession.metadataVersion).toBe(1);
            expect(updatedSession.agentState).toEqual({ controlledByUser: false, requests: {} });
            expect(updatedSession.agentStateVersion).toBe(1);
            expect(params.invalidateSessions).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('does not overwrite a newer title when a lower-version metadata payload arrives (hydrated path)', async () => {
        markSessionSurfaceVisible('s_meta_version_guard');
        storage.getState().applySessions([{
            ...buildSession('s_meta_version_guard'),
            metadata: { path: '/tmp', host: 'localhost', name: 'Newer title' },
            metadataVersion: 5,
        }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_meta_version_stale',
                seq: 11,
                createdAt: 2_000,
                body: {
                    t: 'update-session',
                    id: 's_meta_version_guard',
                    latestReadyEventSeq: 7,
                    latestReadyEventAt: 1_990,
                    // Stale metadata: version 3 < stored version 5.
                    metadata: { version: 3, value: JSON.stringify({ path: '/old', host: 'oldbox', name: 'Stale title' }) },
                },
            },
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        // Stale metadata must NOT overwrite the newer title.
        expect(updatedSession.metadata).toEqual({ path: '/tmp', host: 'localhost', name: 'Newer title' });
        expect(updatedSession.metadataVersion).toBe(5);
        // Projection fields still apply.
        expect(updatedSession.latestReadyEventSeq).toBe(7);
        expect(updatedSession.latestReadyEventAt).toBe(1_990);
        expect(updatedSession.updatedAt).toBe(2_000);
    });

    it('does not emit duplicate Agent side effects when an older decrypt completes after a newer tuple', async () => {
        const sessionId = 's_deferred_agent_side_effect_currentness';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            encryptionMode: 'e2ee',
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 1,
        }]);

        const staleAgentState = {
            controlledByUser: false,
            requests: {
                stalePermission: {
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'echo stale' },
                },
            },
            completedRequests: {},
        };
        const currentAgentState = {
            controlledByUser: false,
            requests: {
                currentPermission: {
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'echo current' },
                },
            },
            completedRequests: {},
        };
        const staleDecrypt = createDeferred<typeof staleAgentState>();
        const decryptAgentState = vi.fn((version: number) =>
            (version === 2
                ? staleDecrypt.promise
                : Promise.resolve(currentAgentState))
                .then(value => ({ status: 'available', value } satisfies AgentStateOpenResult)),
        );
        const applySessions = vi.fn((
            sessions: Parameters<HandleUpdateContainerBaseParams['applySessions']>[0],
        ) => {
            storage.getState().applySessions(sessions);
        });
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata: vi.fn(),
                    decryptAgentStateResult: decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
            applySessions,
        });

        const staleUpdate = handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_agent_state_v2',
                seq: 2,
                createdAt: 2,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    agentState: { version: 2, value: 'agent-state-v2' },
                },
            },
        });
        await expect.poll(() => decryptAgentState.mock.calls.length).toBe(1);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_agent_state_v3',
                seq: 3,
                createdAt: 3,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    agentState: { version: 3, value: 'agent-state-v3' },
                },
            },
        });
        staleDecrypt.resolve(staleAgentState);
        await staleUpdate;

        expect(storage.getState().sessions[sessionId]).toMatchObject({
            agentStateVersion: 3,
            agentState: currentAgentState,
        });
        expect(socketPostDecryptSideEffectMocks.notifyActivityAgentRequest).toHaveBeenCalledTimes(1);
        expect(socketPostDecryptSideEffectMocks.notifyActivityAgentRequest).toHaveBeenCalledWith(
            expect.objectContaining({ requestId: 'currentPermission' }),
        );
        expect(
            socketPostDecryptSideEffectMocks.reportNewAgentRequestsFromSessionTransition,
        ).toHaveBeenCalledTimes(1);
        expect(params.onSessionVisible).toHaveBeenCalledTimes(1);
    });

    it('applies metadata when the incoming version is higher and treats an equal version as a no-op (hydrated path)', async () => {
        markSessionSurfaceVisible('s_meta_version_apply');
        storage.getState().applySessions([{
            ...buildSession('s_meta_version_apply'),
            metadata: { path: '/tmp', host: 'localhost', name: 'Original title' },
            metadataVersion: 2,
        }]);

        // Equal version is a no-op: metadata is not re-applied.
        const equalParams = buildBaseParams();
        await handleUpdateContainer({
            ...equalParams,
            updateData: {
                id: 'u_meta_version_equal',
                seq: 11,
                createdAt: 2_000,
                body: {
                    t: 'update-session',
                    id: 's_meta_version_apply',
                    metadata: { version: 2, value: JSON.stringify({ path: '/equal', host: 'equalbox', name: 'Equal title' }) },
                },
            },
        });
        socketApplyFrame.flushNow();
        const equalSpy = equalParams.applySessions as unknown as ReturnType<typeof vi.fn>;
        const equalSession = equalSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(equalSession.metadata).toEqual({ path: '/tmp', host: 'localhost', name: 'Original title' });
        expect(equalSession.metadataVersion).toBe(2);

        // Higher version applies.
        const higherParams = buildBaseParams();
        await handleUpdateContainer({
            ...higherParams,
            updateData: {
                id: 'u_meta_version_higher',
                seq: 12,
                createdAt: 2_100,
                body: {
                    t: 'update-session',
                    id: 's_meta_version_apply',
                    metadata: { version: 3, value: JSON.stringify({ path: '/new', host: 'newbox', name: 'Newer title' }) },
                },
            },
        });
        socketApplyFrame.flushNow();
        const higherSpy = higherParams.applySessions as unknown as ReturnType<typeof vi.fn>;
        const higherSession = higherSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(higherSession.metadata).toEqual({ path: '/new', host: 'newbox', name: 'Newer title' });
        expect(higherSession.metadataVersion).toBe(3);
    });

    it('applies the first durable session update immediately and coalesces trailing updates without dropping queued fields', async () => {
        markSessionSurfaceVisible('s1');
        vi.useFakeTimers();
        storage.getState().applySessions([buildSession('s1')]);
        const appliedBatches: Session[][] = [];
        const applySessions = vi.fn<HandleUpdateContainerBaseParams['applySessions']>((sessions) => {
            const nextSessions = sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[];
            appliedBatches.push(nextSessions);
            storage.getState().applySessions(nextSessions);
        });
        const params = buildBaseParams({ applySessions });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_coalesce_1',
                seq: 10,
                createdAt: 100,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_coalesce_2',
                seq: 11,
                createdAt: 101,
                body: {
                    t: 'update-session',
                    id: 's1',
                    pendingPermissionRequestCount: 7,
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_coalesce_3',
                seq: 12,
                createdAt: 102,
                body: {
                    t: 'update-session',
                    id: 's1',
                    agentState: { version: 3, value: JSON.stringify({ controlledByUser: true }) },
                },
            },
        });

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(appliedBatches[0]?.[0]).toEqual(expect.objectContaining({
            metadata: { path: '/work', host: 'devbox' },
            metadataVersion: 2,
        }));

        await vi.runAllTimersAsync();

        expect(applySessions).toHaveBeenCalledTimes(2);
        expect(appliedBatches[1]?.[0]).toEqual(expect.objectContaining({
            metadata: { path: '/work', host: 'devbox' },
            metadataVersion: 2,
            pendingPermissionRequestCount: 7,
            agentState: { controlledByUser: true },
            agentStateVersion: 3,
        }));
    });

    it('does not let a queued stale turn projection clear newer working state', async () => {
        vi.useFakeTimers();
        const sessionId = 's_runtime_ordering';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            serverId: getActiveServerSnapshot().serverId,
            seq: 7,
            updatedAt: 1_000,
            thinking: false,
            thinkingAt: 1_000,
            latestTurnId: 'turn-1',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
        }]);
        const applySessions = vi.fn<HandleUpdateContainerBaseParams['applySessions']>((sessions) => {
            storage.getState().applySessions(sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[]);
        });
        const params = buildBaseParams({ applySessions });

        // Starts the coalescing leading window and applies immediately.
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_ordering_initial_terminal',
                seq: 10,
                createdAt: 1_001,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: 'turn-1',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_001,
                    thinking: false,
                    thinkingAt: 1_001,
                },
            },
        });

        storage.getState().applySessions([{
            ...storage.getState().sessions[sessionId]!,
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }]);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_ordering_stale_terminal',
                seq: 11,
                createdAt: 1_005,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: 'turn-1',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_001,
                    thinking: false,
                    thinkingAt: 1_001,
                },
            },
        });

        expect(storage.getState().sessions[sessionId]).toEqual(expect.objectContaining({
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }));

        await vi.runAllTimersAsync();

        expect(storage.getState().sessions[sessionId]).toEqual(expect.objectContaining({
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }));
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toEqual(expect.objectContaining({
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }));
    });

    it('drops queued durable session updates when the session is deleted before the coalesced flush', async () => {
        vi.useFakeTimers();
        storage.getState().applySessions([buildSession('s1')]);
        const applySessions = vi.fn<HandleUpdateContainerBaseParams['applySessions']>((sessions) => {
            storage.getState().applySessions(sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[]);
        });
        const params = buildBaseParams({ applySessions });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_delete_1',
                seq: 10,
                createdAt: 100,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_delete_2',
                seq: 11,
                createdAt: 101,
                body: {
                    t: 'update-session',
                    id: 's1',
                    pendingPermissionRequestCount: 7,
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_delete_3',
                seq: 12,
                createdAt: 102,
                body: {
                    t: 'delete-session',
                    sid: 's1',
                },
            },
        });

        await vi.runAllTimersAsync();

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(storage.getState().sessions.s1).toBeUndefined();
    });

    it.each([
        ['delete-session', { t: 'delete-session' as const, sid: 's1' }],
        ['session-share-revoked', { t: 'session-share-revoked' as const, sessionId: 's1', shareId: 'share-1' }],
    ])('resets shared transcript currentness for %s', async (_kind, body) => {
        const sessionReceivedMessages = new Map<string, Map<string, number>>([
            ['s1', new Map([['voice-history-carrier', 2_000]])],
        ]);
        const resetSessionTranscriptState = vi.fn((sessionId: string) => {
            sessionReceivedMessages.delete(sessionId);
        });
        const params = {
            ...buildBaseParams({ sessionReceivedMessages }),
            resetSessionTranscriptState,
        };

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: `u_${body.t}`,
                seq: 12,
                createdAt: 102,
                body,
            },
        });

        expect(resetSessionTranscriptState).toHaveBeenCalledWith('s1');
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('preserves runtime-local direct-session metadata for loaded plaintext sessions when an update omits externalSessionV1', async () => {
        markSessionSurfaceVisible('s1');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s1'),
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: {
                            kind: 'claudeConfigDir',
                            configDir: '/tmp/.claude',
                        },
                    },
                },
            }]);
            const params = buildBaseParams();
            const updateData: ApiUpdateContainer = {
                id: 'u_plain_session_direct_runtime_local',
                seq: 10,
                createdAt: 1234,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: {
                        version: 2,
                        value: JSON.stringify({
                            path: '/work',
                            host: 'devbox',
                            externalSessionAttentionV1: {
                                v: 1,
                                observedProgressToken: '20:msg-2',
                                viewedProgressToken: '10:msg-1',
                                observedAtMs: 20,
                                viewedAtMs: 10,
                            },
                        }),
                    },
                },
            };

            await handleUpdateContainer({
                ...params,
                updateData,
            });
            socketApplyFrame.flushNow();

            expect(consoleError).not.toHaveBeenCalled();
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession.metadata).toEqual(expect.objectContaining({
                path: '/work',
                host: 'devbox',
                machineId: 'machine-1',
                externalSessionV1: expect.objectContaining({
                    v: 1,
                    agentId: 'claude',
                    remoteSessionId: 'remote-1',
                }),
                externalSessionAttentionV1: expect.objectContaining({
                    v: 1,
                    observedProgressToken: '20:msg-2',
                }),
            }));
        } finally {
            consoleError.mockRestore();
        }
    });

    it('preserves runtime-local direct-session metadata for loaded plaintext sessions when an update sets externalSessionV1 to null', async () => {
        markSessionSurfaceVisible('s1');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s1'),
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: {
                            kind: 'claudeConfigDir',
                            configDir: '/tmp/.claude',
                        },
                    },
                },
            }]);
            const params = buildBaseParams();
            const updateData: ApiUpdateContainer = {
                id: 'u_plain_session_direct_runtime_local_null_link',
                seq: 10,
                createdAt: 1234,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: {
                        version: 2,
                        value: JSON.stringify({
                            path: '/work',
                            host: 'devbox',
                            externalSessionV1: null,
                            externalSessionAttentionV1: {
                                v: 1,
                                observedProgressToken: '20:msg-2',
                                viewedProgressToken: '10:msg-1',
                                observedAtMs: 20,
                                viewedAtMs: 10,
                            },
                        }),
                    },
                },
            };

            await handleUpdateContainer({
                ...params,
                updateData,
            });
            socketApplyFrame.flushNow();

            expect(consoleError).not.toHaveBeenCalled();
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession.metadata).toEqual(expect.objectContaining({
                path: '/work',
                host: 'devbox',
                externalSessionV1: expect.objectContaining({
                    v: 1,
                    agentId: 'claude',
                    remoteSessionId: 'remote-1',
                }),
                externalSessionAttentionV1: expect.objectContaining({
                    v: 1,
                    observedProgressToken: '20:msg-2',
                }),
            }));
        } finally {
            consoleError.mockRestore();
        }
    });

    it('patches cache-only renderables for plaintext update-session without forcing a sessions refresh', async () => {
        demandSessionListRow('s_cached_only');
        replaceActiveSessionListRows([
            {
                id: 's_cached_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only',
            seq: 11,
            createdAt: 1235,
            body: {
                t: 'update-session',
                id: 's_cached_only',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        externalSessionV1: {
                            v: 1,
                            agentId: 'claude',
                            machineId: 'machine-1',
                            remoteSessionId: 'remote-1',
                            source: {
                                kind: 'claudeConfig',
                                configDir: '/tmp/.claude',
                            },
                        },
                        externalSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_only']).find(Boolean)).toEqual(
            expect.objectContaining({
                updatedAt: 1235,
                seq: 1,
                metadataVersion: 2,
                metadata: expect.objectContaining({
                    path: '/work',
                    host: 'devbox',
                }),
                hasUnreadMessages: true,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('patches cache-only renderables for active-only update-session without forcing a sessions refresh', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_active_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_active_only_cache_only',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_active_only',
                    active: false,
                    activeAt: 1230,
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_active_only']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1230,
                thinking: false,
                thinkingAt: 1230,
                updatedAt: 1236,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it.each([
        { kind: 'runtime-activity', createdAt: 300 },
        { kind: 'turn', createdAt: 300 },
        { kind: 'ready', createdAt: 300 },
        { kind: 'runtime-activity', createdAt: 400 },
    ] as const)('accepts independently newer $kind facts behind an unrelated row timestamp ($createdAt)', async ({ kind, createdAt }) => {
        vi.useFakeTimers();
        const sessionId = 's_independent_projection_ordering';
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        replaceActiveSessionListRows([{
            ...buildSession(sessionId), serverId, updatedAt: 400, activeAt: 10_000,
            latestTurnId: 'turn-1', latestTurnStatus: kind === 'turn' ? 'in_progress' : 'completed',
            latestTurnStatusObservedAt: 100,
            runtimeActivityState: kind === 'runtime-activity' ? 'active' : 'idle',
            runtimeActivityActiveCount: kind === 'runtime-activity' ? 1 : 0,
            runtimeActivityObservedAt: 100, runtimeActivityRevision: 1,
            latestReadyEventSeq: 1, latestReadyEventAt: 100,
            archivedAt: null, lastViewedSessionSeq: 1, hasUnreadMessages: false,
        }]);
        const params = buildBaseParams({ sourceServerId: serverId });
        if (createdAt === 400) {
            await handleUpdateContainer({ ...params, updateData: { id: 'newer-envelope', seq: 6, createdAt,
                body: { t: 'update-session', id: sessionId, archivedAt: null } } });
            await vi.advanceTimersByTimeAsync(100);
        }
        const lifecycle = kind === 'runtime-activity'
            ? { runtimeActivityState: 'idle' as const, runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: 300, runtimeActivityRevision: 2 }
            : kind === 'turn'
                ? { latestTurnStatus: 'completed' as const, latestTurnStatusObservedAt: 300 }
                : { latestReadyEventSeq: 2, latestReadyEventAt: 300 };
        await handleUpdateContainer({
            ...params,
            updateData: { id: 'independently-newer', seq: 4, createdAt,
                body: { t: 'update-session', id: sessionId, archivedAt: 250, ...lifecycle } },
        });
        await vi.advanceTimersByTimeAsync(100);

        expect(storage.getState().sessionListRowsByServerId[serverId][sessionId]).toMatchObject({
            ...lifecycle, updatedAt: 400, archivedAt: null,
        });
        if (kind === 'ready') expect(storage.getState().sessionListRowsByServerId[serverId][sessionId].hasUnreadMessages).toBe(true);
        else expect(projectUiSessionRuntimeAwareness({ ...storage.getState().sessionListRowsByServerId[serverId][sessionId], nowMs: 10_000 }).working).toBe(false);
        expect(params.invalidateSessions).not.toHaveBeenCalled();

        const settledRow = storage.getState().sessionListRowsByServerId[serverId][sessionId];
        let rowNotifications = 0;
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.sessionListRowsByServerId[serverId]?.[sessionId] !== previous.sessionListRowsByServerId[serverId]?.[sessionId]) rowNotifications++;
        });
        try {
            await handleUpdateContainer({ ...params, updateData: { id: 'duplicate-lifecycle', seq: 4, createdAt,
                body: { t: 'update-session', id: sessionId, archivedAt: 250, ...lifecycle } } });
            await vi.advanceTimersByTimeAsync(100);
            expect(storage.getState().sessionListRowsByServerId[serverId][sessionId]).toBe(settledRow);
            expect(rowNotifications).toBe(0);
        } finally {
            unsubscribe();
        }

        // A later envelope cannot roll back independently ordered facts either.
        await handleUpdateContainer({
            ...params,
            updateData: { id: 'older-lifecycle-newer-envelope', seq: 7, createdAt: 500,
                body: { t: 'update-session', id: sessionId,
                    runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 50, runtimeActivityRevision: 0,
                    latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 50,
                    latestReadyEventSeq: 0, latestReadyEventAt: 50 } },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(storage.getState().sessionListRowsByServerId[serverId][sessionId]).toMatchObject(lifecycle);
    });

    it('patches cache-only renderables for runtime activity update-session without forcing a sessions refresh', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_runtime_activity_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                latestTurnStatus: 'completed',
                runtimeActivityState: 'unknown',
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 0,
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_activity_only_cache_only',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_runtime_activity_only',
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 1200,
                    runtimeActivityRevision: 132_000,
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_runtime_activity_only']).find(Boolean)).toEqual(
            expect.objectContaining({
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 1200,
                runtimeActivityRevision: 132_000,
                updatedAt: 1236,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('retains cache-only runtime activity truth and target-hydrates on an equal-revision conflict', async () => {
        demandSessionListRow('s_cached_runtime_conflict');
        vi.useFakeTimers();
        replaceActiveSessionListRows([{
            id: 's_cached_runtime_conflict',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: { path: '/tmp', host: 'localhost' },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_100,
            runtimeActivityRevision: 7,
            hasUnreadMessages: false,
        }]);

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_activity_conflict_cache_only',
                seq: 12,
                createdAt: 1_236,
                body: {
                    t: 'update-session',
                    id: 's_cached_runtime_conflict',
                    runtimeActivityState: 'idle',
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: 1_200,
                    runtimeActivityRevision: 7,
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_runtime_conflict']).find(Boolean)).toEqual(
            expect.objectContaining({
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 1_100,
                runtimeActivityRevision: 7,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith(
            's_cached_runtime_conflict',
            'socket-update-runtime-activity-conflict',
        );
        await vi.runAllTimersAsync();
    });

    it('retains hydrated runtime activity truth and target-hydrates on an equal-revision conflict', async () => {
        markSessionSurfaceVisible('s_hydrated_runtime_conflict');
        storage.getState().applySessions([{
            ...buildSession('s_hydrated_runtime_conflict'),
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_100,
            runtimeActivityRevision: 7,
        }]);

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_activity_conflict_hydrated',
                seq: 12,
                createdAt: 1_236,
                body: {
                    t: 'update-session',
                    id: 's_hydrated_runtime_conflict',
                    runtimeActivityState: 'idle',
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: 1_200,
                    runtimeActivityRevision: 7,
                },
            },
        });
        socketApplyFrame.flushNow();

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_100,
            runtimeActivityRevision: 7,
        }));
        expect(hydrateSessionById).toHaveBeenCalledWith(
            's_hydrated_runtime_conflict',
            'socket-update-runtime-activity-conflict',
        );
    });

    it('preserves last-good responsibility and target-hydrates a malformed socket half-tuple', async () => {
        markSessionSurfaceVisible('s_responsibility_half_tuple');
        const responsibleAccount = {
            kind: 'account' as const,
            accountId: 'account-alice',
            name: 'Alice',
            firstName: 'Alice',
            lastName: null,
            username: 'alice',
            avatarUrl: null,
        };
        storage.getState().applySessions([{
            ...buildSession('s_responsibility_half_tuple'),
            responsibleAccountId: responsibleAccount.accountId,
            responsibleAccount,
        }]);

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_responsibility_half_tuple',
                seq: 12,
                createdAt: 1_236,
                body: {
                    t: 'update-session',
                    id: 's_responsibility_half_tuple',
                    responsibleAccountId: 'account-bob',
                },
            },
        });
        socketApplyFrame.flushNow();

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            responsibleAccountId: responsibleAccount.accountId,
            responsibleAccount,
        }));
        expect(hydrateSessionById).toHaveBeenCalledWith(
            's_responsibility_half_tuple',
            'socket-update-responsibility-invalid',
        );
    });

    it('target-hydrates visible cache-only renderables after update-session projection patches', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        replaceActiveSessionListRows([
            {
                id: 's_cached_visible_update',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);
        markSessionSurfaceVisible('s_cached_visible_update', serverId);

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            sourceServerId: serverId,
            updateData: {
                id: 'u_visible_cache_only_update',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_visible_update',
                    active: false,
                    activeAt: 1230,
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_visible_update']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1230,
                thinking: false,
                thinkingAt: 1230,
                updatedAt: 1236,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_visible_update', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates route-anchored cache-only renderables after update-session projection patches', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_route_update',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);
        setRouteAnchorSessionId('s_cached_route_update');

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_route_cache_only_update',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_route_update',
                    active: false,
                    activeAt: 1230,
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_route_update']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1230,
                thinking: false,
                thinkingAt: 1230,
                updatedAt: 1236,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_route_update', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it.each(['terminal', 'earlier-turn-anchors'] as const)('target-hydrates live full-content session turn projections after %s updates', async kind => {
        const sessionId = 's_live_turn_projection';
        const sourceServerId = 'server-live-turns';
        markSessionSurfaceVisible(sessionId, sourceServerId);
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            active: false,
            latestTurnId: 'turn-1',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_100,
        }]);

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            sourceServerId,
            updateData: {
                id: 'u_live_turn_projection',
                seq: 14,
                createdAt: 1_237,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: kind === 'terminal' ? 'turn-1' : 'turn-2',
                    latestTurnStatus: kind === 'terminal' ? 'completed' : 'in_progress',
                    latestTurnStatusObservedAt: 1_235,
                    ...(kind === 'earlier-turn-anchors' ? { rollbackEligibleTurnStarts: [17] } : {}),
                },
            },
        });

        expect(hydrateSessionById).toHaveBeenCalledWith(sessionId, 'socket-update-turn-projection');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('keeps layout-0 metadata socket patches on the existing inline hydration path', async () => {
        const sessionId = 's_layout0_inline_metadata';
        markSessionSurfaceVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId)]);
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_layout0_inline_metadata',
                seq: 14,
                createdAt: 1_237,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    metadata: {
                        version: 2,
                        value: JSON.stringify({
                            path: '/updated',
                            host: 'layout0-host',
                        }),
                    },
                },
            },
        });
        socketApplyFrame.flushNow();

        expect(hydrateSessionById).not.toHaveBeenCalled();
        const appliedSession = (
            params.applySessions as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.at(-1)?.[0]?.[0] as Session | undefined;
        expect(appliedSession).toEqual(expect.objectContaining({
            metadataLayoutVersion: 0,
            metadataVersion: 2,
            metadata: {
                path: '/updated',
                host: 'layout0-host',
            },
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('keeps the last-known owner view while it target-hydrates layout-1 owner metadata after a shared metadata socket patch', async () => {
        const sessionId = 's_layout1_owner_refresh';
        markSessionSurfaceVisible(sessionId);
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            metadataLayoutVersion: 1,
            metadata: { v: 1 } as any,
            ownerMetadataView: {
                path: '/private/worktree',
                host: 'private',
            } as any,
        }]);
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_layout1_owner_refresh',
                seq: 14,
                createdAt: 1_237,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    metadataLayoutVersion: 1,
                    metadata: {
                        version: 2,
                        value: JSON.stringify({ v: 1 }),
                    },
                },
            },
        });
        socketApplyFrame.flushNow();

        expect(hydrateSessionById).toHaveBeenCalledWith(
            sessionId,
            'socket-update-owner-metadata',
        );
        const appliedSession = (
            params.applySessions as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.at(-1)?.[0]?.[0] as Session | undefined;
        // The owner view for the new revision is re-read by the targeted hydration. Until it
        // lands, the last-known owner view stays: dropping it would hide the owner's row (its
        // hidden-system answer becomes unknown) and flip its title on every metadata write.
        expect(appliedSession?.metadataVersion).toBe(2);
        expect(appliedSession?.ownerMetadataView).toEqual({ path: '/private/worktree', host: 'private' });
        expect(appliedSession).not.toHaveProperty('ownerMetadata');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    describe('layout-1 owner frames that omit the unchanged owner envelope', () => {
        const ownerMetadata = { v: 1 as const, workspace: { path: '/private/worktree', host: 'private-host', name: 'Owner title' } };
        const ownerEnvelope = createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
        const credentials = { token: 'token', secret: 'secret' } as unknown as AuthCredentials;
        function seedOwnerSession(sessionId: string): Session {
            const access = createSessionAccessFixture('owner');
            const shared = projectSessionSharedMetadataV1({ metadata: {} });
            const ownerRead = readSessionLayout1OwnerMetadata({ access, accountMode: 'plain', ownerMetadataEnvelope: ownerEnvelope, credentials });
            const projection = projectSessionLayout1OwnerMetadata({ sharedMetadata: shared, ownerMetadataRead: ownerRead, metadataVersion: 1 });
            if (projection.kind !== 'owner') throw new Error('expected an opened owner projection');
            const session: Session = { ...buildSession(sessionId), access, metadataLayoutVersion: 1,
                metadata: shared as unknown as Session['metadata'], ownerMetadataView: projection.ownerMetadataView,
                composerOptionsInput: projection.composerOptionsInput, [SESSION_OWNER_METADATA_PROJECTION]: projection };
            storage.getState().applySessions([session]);
            markSessionSurfaceVisible(sessionId);
            return session;
        }
        const tupleFrame = (sessionId: string, seq: number, metadataVersion: number, extra: Record<string, unknown> = {}) => ({
            id: `u_${sessionId}_${seq}`, seq, createdAt: 1_000 + seq,
            body: { t: 'update-session' as const, id: sessionId, metadataLayoutVersion: 1,
                metadata: { version: metadataVersion, value: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })) },
                ...extra },
        });

        it('applies N Agent-state frames by version with zero Session re-reads and keeps the owner view current', async () => {
            const sessionId = 's_layout1_owner_delta';
            seedOwnerSession(sessionId);
            const params = buildBaseParams({ applySessions: rows => storage.getState().applySessions(rows) });
            for (let i = 1; i <= 5; i++) {
                await handleUpdateContainer({ ...params, updateData: tupleFrame(sessionId, 10 + i, 1 + i, {
                    agentState: { version: 1 + i, value: JSON.stringify({ requests: { [`r${i}`]: {
                        tool: 'Bash', kind: 'permission', arguments: { command: `echo ${i}` }, createdAt: 100 + i } } }) },
                }) });
            }
            // Applies are coalesced; wait for the batch to land in the store.
            await vi.waitFor(() => expect(storage.getState().sessions[sessionId].metadataVersion).toBe(6));
            expect(params.hydrateSessionById).not.toHaveBeenCalled();
            const next = storage.getState().sessions[sessionId];
            expect(next.agentStateVersion).toBe(6);
            expect(Object.keys(next.agentState?.requests ?? {})).toEqual(['r5']);
            expect(next[SESSION_OWNER_METADATA_PROJECTION]?.admittedMetadataVersion).toBe(6);
            expect(next.ownerMetadataView).toMatchObject({ path: '/private/worktree', host: 'private-host' });
        });

        it('re-reads exactly once on a revision gap', async () => {
            const sessionId = 's_layout1_owner_gap';
            seedOwnerSession(sessionId);
            const params = buildBaseParams({ applySessions: rows => storage.getState().applySessions(rows) });
            await handleUpdateContainer({ ...params, updateData: tupleFrame(sessionId, 11, 3) });
            expect(params.hydrateSessionById).toHaveBeenCalledExactlyOnceWith(sessionId, 'socket-update-owner-metadata');
        });

        it('still hands a full document (with its owner envelope) to the canonical owner reader', async () => {
            const sessionId = 's_layout1_owner_full';
            seedOwnerSession(sessionId);
            const params = buildBaseParams({ applySessions: rows => storage.getState().applySessions(rows) });
            await handleUpdateContainer({ ...params, updateData: tupleFrame(sessionId, 11, 2, {
                ownerMetadata: { value: ownerEnvelope }, agentState: { version: 2, value: null } }) });
            expect(params.hydrateSessionById).toHaveBeenCalledExactlyOnceWith(sessionId, 'socket-update-owner-metadata');
            await vi.waitFor(() => expect(storage.getState().sessions[sessionId].metadataVersion).toBe(2));
        });
    });

    it.each(['view', 'edit', 'admin'] as const)(
        'applies a layout-1 %s participant shared metadata patch without requesting owner hydration',
        async (accessLevel) => {
            const sessionId = `s_layout1_${accessLevel}_participant_shared_patch`;
            markSessionSurfaceVisible(sessionId);
            storage.getState().applySessions([{
                ...buildSession(sessionId),
                metadataLayoutVersion: 1,
                metadata: { v: 1 } as unknown as Session['metadata'],
                ownerMetadataView: null,
                accessLevel,
            }]);
            const hydrateSessionById = vi.fn();
            const params = buildBaseParams({ hydrateSessionById });

            await handleUpdateContainer({
                ...params,
                updateData: {
                    id: `u_layout1_${accessLevel}_participant_shared_patch`,
                    seq: 15,
                    createdAt: 1_238,
                    body: {
                        t: 'update-session',
                        id: sessionId,
                        metadataLayoutVersion: 1,
                        metadata: {
                            version: 2,
                            value: JSON.stringify({
                                v: 1,
                                summary: { text: 'Shared title', updatedAt: 1_238 },
                            }),
                        },
                    },
                },
            });
            socketApplyFrame.flushNow();

            expect(hydrateSessionById).not.toHaveBeenCalled();
            const appliedSession = (
                params.applySessions as unknown as ReturnType<typeof vi.fn>
            ).mock.calls.at(-1)?.[0]?.[0] as Session | undefined;
            expect(appliedSession).toEqual(expect.objectContaining({
                metadataLayoutVersion: 1,
                metadataVersion: 2,
                metadata: {
                    v: 1,
                    summary: { text: 'Shared title', updatedAt: 1_238 },
                },
                ownerMetadataView: null,
                accessLevel,
            }));
            expect(appliedSession).not.toHaveProperty('ownerMetadata');
            expect(params.invalidateSessions).not.toHaveBeenCalled();
        },
    );

    it('retains layout-1 participant turn-projection hydration without requesting owner metadata', async () => {
        const sessionId = 's_layout1_participant_turn_projection';
        const sourceServerId = 'server-layout1-participant-turns';
        markSessionSurfaceVisible(sessionId, sourceServerId);
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            metadataLayoutVersion: 1,
            metadata: { v: 1 } as unknown as Session['metadata'],
            ownerMetadataView: null,
            accessLevel: 'view',
            latestTurnId: 'turn-participant-1',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_200,
        }]);
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            sourceServerId,
            updateData: {
                id: 'u_layout1_participant_turn_projection',
                seq: 16,
                createdAt: 1_240,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    metadataLayoutVersion: 1,
                    metadata: {
                        version: 2,
                        value: JSON.stringify({ v: 1 }),
                    },
                    latestTurnId: 'turn-participant-1',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_239,
                },
            },
        });
        socketApplyFrame.flushNow();

        expect(hydrateSessionById).toHaveBeenCalledTimes(1);
        expect(hydrateSessionById).toHaveBeenCalledWith(
            sessionId,
            'socket-update-turn-projection',
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('coalesces cache-only non-urgent update-session projection patches until the activity window flushes', async () => {
        vi.useFakeTimers();
        replaceActiveSessionListRows([
            {
                id: 's_cached_progress_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                latestReadyEventSeq: 10,
                lastViewedSessionSeq: 1,
                hasUnreadMessages: true,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_progress_only',
                seq: 11,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_progress_only',
                    latestTurnStatusObservedAt: 1235,
                    meaningfulActivityAt: 1235,
                },
            },
        });

        const beforeFlush = Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_progress_only']).find(Boolean);
        expect(beforeFlush?.latestTurnStatusObservedAt).toBeUndefined();
        expect(beforeFlush?.meaningfulActivityAt).toBeUndefined();
        expect(beforeFlush?.updatedAt).toBe(1);

        await vi.runAllTimersAsync();

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_progress_only']).find(Boolean)).toEqual(
            expect.objectContaining({
                latestTurnStatusObservedAt: 1235,
                meaningfulActivityAt: 1235,
                updatedAt: 1236,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('applies urgent cache-only pending projection immediately after queued non-urgent progress', async () => {
        vi.useFakeTimers();
        replaceActiveSessionListRows([
            {
                id: 's_cached_urgent_after_progress',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                latestReadyEventSeq: null,
                lastViewedSessionSeq: 100,
                hasUnreadMessages: false,
                hasPendingPermissionRequests: false,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_progress_before_urgent',
                seq: 11,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_urgent_after_progress',
                    latestTurnStatusObservedAt: 1235,
                    meaningfulActivityAt: 1235,
                },
            },
        });

        const beforePending = Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_urgent_after_progress']).find(Boolean);
        expect(beforePending?.latestTurnStatusObservedAt).toBeUndefined();
        expect(beforePending?.hasPendingPermissionRequests).toBe(false);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_urgent_pending',
                seq: 12,
                createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: 's_cached_urgent_after_progress',
                    pendingPermissionRequestCount: 1,
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_urgent_after_progress']).find(Boolean)).toEqual(
            expect.objectContaining({
                latestTurnStatusObservedAt: 1235,
                meaningfulActivityAt: 1235,
                hasPendingPermissionRequests: true,
                updatedAt: 1237,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();
    });

    it('marks cache-only renderables unread when ready projection advances past the read cursor', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_ready_unread',
                seq: 945,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                lastViewedSessionSeq: 945,
                latestReadyEventSeq: null,
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_ready_unread',
            seq: 946,
            createdAt: 1236,
            body: {
                t: 'update-session',
                id: 's_cached_ready_unread',
                latestReadyEventSeq: 946,
                latestReadyEventAt: 1236,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_ready_unread']).find(Boolean)).toEqual(
            expect.objectContaining({
                latestReadyEventSeq: 946,
                latestReadyEventAt: 1236,
                hasUnreadMessages: true,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('replaces private cache-only attention on an otherwise ordinary session update', async () => {
        const viewer = {
            latestFailureSeq: null,
            readState: { state: 'not_started' as const },
            relevance: { relevant: true, reasons: ['responsible_for_me' as const] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
            follow: { follows: false, notificationLevel: 'none' as const },
            notification: { level: 'none' as const, source: 'preference' as const },
        };
        replaceActiveSessionListRows([{
            ...buildSession('private-cached'), archivedAt: null,
            lastViewedSessionSeq: 0, latestReadyEventSeq: 8, hasUnreadMessages: true,
        }]);
        await handleUpdateContainer({
            ...buildBaseParams(),
            updateData: { id: 'private-update', seq: 8, createdAt: 2, body: {
                t: 'update-session', id: 'private-cached', active: true, viewer,
            } },
        });
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['private-cached']).find(Boolean)).toMatchObject({ viewer, hasUnreadMessages: false });
    });

    it('clears cache-only renderable unread when read cursor catches the ready projection', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_ready_read',
                seq: 946,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                lastViewedSessionSeq: 945,
                latestReadyEventSeq: 946,
                hasUnreadMessages: true,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_ready_read',
            seq: 947,
            createdAt: 1237,
            body: {
                t: 'update-session',
                id: 's_cached_ready_read',
                lastViewedSessionSeq: 946,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_ready_read']).find(Boolean)).toEqual(
            expect.objectContaining({
                lastViewedSessionSeq: 946,
                hasUnreadMessages: false,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('does not overwrite a newer cache-only title when a lower-version metadata payload arrives', async () => {
        demandSessionListRow('s_cached_meta_version_guard');
        replaceActiveSessionListRows([
            {
                id: 's_cached_meta_version_guard',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 5,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost', name: 'Newer title' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_meta_version_stale',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'update-session',
                    id: 's_cached_meta_version_guard',
                    latestReadyEventSeq: 7,
                    // Stale metadata: version 3 < stored 5.
                    metadata: { version: 3, value: JSON.stringify({ path: '/old', host: 'oldbox', name: 'Stale title' }) },
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_meta_version_guard']).find(Boolean)).toEqual(
            expect.objectContaining({
                metadata: expect.objectContaining({ name: 'Newer title' }),
                metadataVersion: 5,
                latestReadyEventSeq: 7,
                updatedAt: 1238,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it.each([1, 2000])('recomputes cache-only unread state and headline after metadata read-state updates (row timestamp: %s)', async (updatedAt) => {
        demandSessionListRow('s_cached_metadata_read_state');
        replaceActiveSessionListRows([
            {
                id: 's_cached_metadata_read_state',
                seq: 9,
                createdAt: 1,
                updatedAt,
                active: true,
                activeAt: 1,
                archivedAt: null,
                agentActivityHeadline: { v: 1, backendId: 'claude', updatedAt: 1,
                    activeEntries: [{ entryId: 'workflow_agent:wf_1:toolu_1', kind: 'workflow_agent',
                        title: 'Previous work', status: 'running', updatedAt: 1 }] },
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    readStateV1: { v: 1, sessionSeq: 1, pendingActivityAt: 0, updatedAt: 1 },
                },
                latestReadyEventSeq: 9,
                hasUnreadMessages: true,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_metadata_read_state_cache_only',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'update-session',
                    id: 's_cached_metadata_read_state',
                    metadata: {
                        version: 2,
                        value: JSON.stringify({
                            sessionAgentActivityHeadlineV1: { v: 1, backendId: 'claude', updatedAt: 1238, activeEntries: [] },
                            path: '/work',
                            host: 'devbox',
                            readStateV1: { v: 1, sessionSeq: 14, pendingActivityAt: 0, updatedAt: 1238 },
                        }),
                    },
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_metadata_read_state']).find(Boolean)).toEqual(
            expect.objectContaining({
                agentActivityHeadline: { v: 1, backendId: 'claude', updatedAt: 1238, activeEntries: [] },
                metadataVersion: 2,
                metadata: expect.objectContaining({
                    path: '/work',
                    readStateV1: expect.objectContaining({ sessionSeq: 14 }),
                }),
                hasUnreadMessages: false,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('patches cache-only encrypted metadata while deferring hidden encrypted agentState', async () => {
        demandSessionListRow('s_cached_encrypted_state');
        replaceActiveSessionListRows([
            {
                id: 's_cached_encrypted_state',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 1,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const decryptMetadata = vi.fn(async () => ({ path: '/work', host: 'devbox' }));
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata,
                    decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });
        const updateData: ApiUpdateContainer = {
            id: 'u_encrypted_cache_only_state',
            seq: 12,
            createdAt: 1236,
            body: {
                t: 'update-session',
                id: 's_cached_encrypted_state',
                metadata: { version: 2, value: 'encrypted-metadata' },
                agentState: { version: 3, value: 'encrypted-agent-state' },
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1236,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(decryptMetadata).toHaveBeenCalledTimes(1);
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_encrypted_state']).find(Boolean)).toEqual(
            expect.objectContaining({
                updatedAt: 1236,
                metadataVersion: 2,
                agentStateVersion: 1,
                metadata: expect.objectContaining({ path: '/work', host: 'devbox' }),
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1236,
            }),
        );
    });

    it('patches archivedAt on cache-only renderables without forcing a sessions refresh', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_archived',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_archived',
            seq: 12,
            createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: 's_cached_archived',
                    latestTurnId: 'turn-2',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_236,
                    archivedAt: 44,
                },
            };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_archived']).find(Boolean)).toEqual(
            expect.objectContaining({
                archivedAt: 44,
                latestTurnId: 'turn-2',
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1_236,
                updatedAt: 1237,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates cache-only renderables for pending-changed without forcing a sessions refresh', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_pending',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingBlockedCount: 1,
                pendingVersion: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);
        const initialIndexByServerId = storage.getState().sessionListIndexByServerId;

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_pending_cache_only',
            seq: 12,
            createdAt: 1236,
            body: {
                t: 'pending-changed',
                sid: 's_cached_pending',
                pendingCount: 4,
                pendingVersion: 8,
                meaningfulActivityAt: 1_235,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_pending']).find(Boolean)).toEqual(
            expect.objectContaining({
                pendingCount: 4,
                pendingBlockedCount: 1,
                pendingVersion: 8,
                meaningfulActivityAt: 1_235,
            }),
        );
        expect(storage.getState().sessionListIndexByServerId).toBe(initialIndexByServerId);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('clears cache-only blocked pending state when pending-changed sends explicit zero', async () => {
        replaceActiveSessionListRows([
            {
                id: 's_cached_pending_clear',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 2,
                pendingBlockedCount: 1,
                pendingVersion: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_pending_cache_only_clear',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'pending-changed',
                    sid: 's_cached_pending_clear',
                    pendingCount: 1,
                    pendingBlockedCount: 0,
                    pendingVersion: 8,
                },
            } as ApiUpdateContainer,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_pending_clear']).find(Boolean)).toEqual(
            expect.objectContaining({
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 8,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates visible cache-only renderables after pending-changed patches', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        replaceActiveSessionListRows([
            {
                id: 's_cached_visible_pending',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);
        markSessionSurfaceVisible('s_cached_visible_pending', serverId);
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            sourceServerId: serverId,
            updateData: {
                id: 'u_visible_pending_cache_only',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'pending-changed',
                    sid: 's_cached_visible_pending',
                    pendingCount: 4,
                    pendingVersion: 8,
                    meaningfulActivityAt: 1_235,
                },
            },
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_visible_pending']).find(Boolean)).toEqual(
            expect.objectContaining({
                pendingCount: 4,
                pendingVersion: 8,
                meaningfulActivityAt: 1_235,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_visible_pending', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates hydrated sessions for pending-changed meaningful activity without forcing a sessions refresh', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_pending_hydrated'),
            pendingCount: 0,
            pendingBlockedCount: 1,
            pendingVersion: 1,
            meaningfulActivityAt: 100,
        }]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_pending_hydrated',
                seq: 13,
                createdAt: 1_236,
                body: {
                    t: 'pending-changed',
                    sid: 's_pending_hydrated',
                    pendingCount: 2,
                    pendingVersion: 9,
                    meaningfulActivityAt: 1_235,
                },
            } as ApiUpdateContainer,
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_pending_hydrated',
            pendingCount: 2,
            pendingBlockedCount: 1,
            pendingVersion: 9,
            meaningfulActivityAt: 1_235,
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('clears hydrated blocked pending state when pending-changed sends explicit zero', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_pending_hydrated_clear'),
            pendingCount: 2,
            pendingBlockedCount: 1,
            pendingVersion: 1,
        }]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_pending_hydrated_clear',
                seq: 13,
                createdAt: 1_236,
                body: {
                    t: 'pending-changed',
                    sid: 's_pending_hydrated_clear',
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 9,
                },
            } as ApiUpdateContainer,
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_pending_hydrated_clear',
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 9,
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('prunes cached server-owned pending rows when pending-changed sends zero queued rows', async () => {
        const sessionId = 's_hydrated_pending_detail_clear';
        storage.getState().applySessions([{ ...buildSession(sessionId), pendingCount: 1, pendingVersion: 1 }]);
        storage.getState().applyPendingMessages(sessionId, [
            {
                id: 'server-pending-1',
                localId: 'server-pending-1',
                createdAt: 1,
                updatedAt: 1,
                source: 'server_pending',
                text: 'sent to provider',
                rawRecord: {},
            },
            {
                id: 'local-outbound-1',
                localId: 'local-outbound-1',
                createdAt: 2,
                updatedAt: 2,
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'saving locally',
                rawRecord: {},
            },
            {
                id: 'local-accepted-1',
                localId: 'local-accepted-1',
                createdAt: 3,
                updatedAt: 3,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'server_delivering',
                text: 'already handed to the server',
                rawRecord: {},
            },
            {
                id: 'local-external-1',
                localId: 'local-external-1',
                createdAt: 4,
                updatedAt: 4,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
                text: 'external custody remains visible',
                rawRecord: {},
            },
            {
                id: 'local-blocked-1',
                localId: 'local-blocked-1',
                createdAt: 5,
                updatedAt: 5,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'blocked',
                text: 'blocked custody remains visible',
                rawRecord: {},
            },
            {
                id: 'local-cancel-1',
                localId: 'local-cancel-1',
                createdAt: 6,
                updatedAt: 6,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'server_delivering',
                pendingOutboxOperation: 'cancel',
                text: 'cancel custody remains visible',
                rawRecord: {},
            },
        ]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hydrated_pending_detail_clear',
                seq: 13,
                createdAt: 1237,
                body: {
                    t: 'pending-changed',
                    sid: sessionId,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 5,
                },
            } as ApiUpdateContainer,
        });

        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
            'local-outbound-1',
            'local-external-1',
            'local-blocked-1',
            'local-cancel-1',
        ]);
    });

    it('patches hydrated share permission updates without forcing a sessions refresh', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_share_existing'),
            access: normalizeSessionAccessProjection({
                share: { accessLevel: 'view', canApprovePermissions: false },
            }, { allowLegacy: true }),
            accessLevel: 'view',
            canApprovePermissions: false,
        }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_existing',
                seq: 14,
                createdAt: 1_238,
                body: {
                    t: 'session-share-updated',
                    sessionId: 's_share_existing',
                    shareId: 'share_1',
                    accessLevel: 'admin',
                    canApprovePermissions: true,
                    updatedAt: 1_238,
                },
            } as ApiUpdateContainer,
        });
        socketApplyFrame.flushNow();

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_share_existing',
            accessLevel: 'admin',
            canApprovePermissions: true,
            access: expect.objectContaining({
                role: 'recipient',
                level: 'admin',
                capabilities: expect.objectContaining({
                    manageAccess: true,
                    approveRuntimePermissions: true,
                }),
            }),
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it.each([
        ['a sourced current projection', {
            ...normalizeSessionAccessProjection({
                share: { accessLevel: 'view', canApprovePermissions: false },
            }, { allowLegacy: true })!,
            sources: [{ kind: 'direct' as const, shareId: 'share_current' }],
        }],
        ['malformed current authority normalized to null', null],
    ])('does not let a released share event replace %s', async (_name, access) => {
        storage.getState().applySessions([{
            ...buildSession('s_share_current_authority'),
            access,
            accessLevel: 'view',
            canApprovePermissions: false,
        }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_current_authority',
                seq: 15,
                createdAt: 1_239,
                body: {
                    t: 'session-share-updated',
                    sessionId: 's_share_current_authority',
                    shareId: 'share_current',
                    accessLevel: 'admin',
                    canApprovePermissions: true,
                    updatedAt: 1_239,
                },
            } as ApiUpdateContainer,
        });
        socketApplyFrame.flushNow();

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            access,
            accessLevel: 'admin',
            canApprovePermissions: true,
        }));
    });

    it('target-hydrates old share updates that cannot prove canApprovePermissions', async () => {
        markSessionSurfaceVisible('s_share_legacy_payload');
        storage.getState().applySessions([{
            ...buildSession('s_share_legacy_payload'),
            accessLevel: 'edit',
            canApprovePermissions: false,
        }]);
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById } as Partial<HandleUpdateContainerBaseParams>);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_legacy_payload',
                seq: 16,
                createdAt: 1_240,
                body: {
                    t: 'session-share-updated',
                    sessionId: 's_share_legacy_payload',
                    shareId: 'share_legacy',
                    accessLevel: 'admin',
                    updatedAt: 1_240,
                },
            } as ApiUpdateContainer,
        });
        socketApplyFrame.flushNow();

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_share_legacy_payload',
            accessLevel: 'admin',
            canApprovePermissions: false,
        }));
        expect(hydrateSessionById).toHaveBeenCalledWith('s_share_legacy_payload', 'share-visibility-change');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('uses targeted session hydration for newly shared sessions instead of invalidating the full list', async () => {
        markSessionSurfaceVisible('s_share_new');
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById } as Partial<HandleUpdateContainerBaseParams>);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_new',
                seq: 15,
                createdAt: 1_239,
                body: {
                    t: 'session-shared',
                    sessionId: 's_share_new',
                    shareId: 'share_2',
                    sharedBy: { id: 'u1', firstName: null, lastName: null, username: 'owner', avatar: null },
                    accessLevel: 'edit',
                    canApprovePermissions: true,
                    createdAt: 1_239,
                },
            } as ApiUpdateContainer,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_share_new', 'share-visibility-change');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('forwards targeted session hydration through the parsed socket update path', async () => {
        markSessionSurfaceVisible('s_share_socket_path');
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById } as Partial<HandleUpdateContainerBaseParams>);

        await handleSocketUpdate({
            ...params,
            update: {
                id: 'u_share_new_socket_path',
                seq: 16,
                createdAt: 1_240,
                body: {
                    t: 'session-shared',
                    sessionId: 's_share_socket_path',
                    shareId: 'share_3',
                    sharedBy: { id: 'u1', firstName: null, lastName: null, username: 'owner', avatar: null },
                    accessLevel: 'edit',
                    canApprovePermissions: true,
                    createdAt: 1_240,
                },
            } as ApiUpdateContainer,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_share_socket_path', 'share-visibility-change');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('preserves direct-session classification for cache-only renderables when an update omits externalSessionV1', async () => {
        demandSessionListRow('s_cached_direct');
        replaceActiveSessionListRows([
            {
                id: 's_cached_direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'claudeConfig', configDir: '/tmp/.claude' },
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_direct_runtime_local',
            seq: 11,
            createdAt: 1235,
            body: {
                t: 'update-session',
                id: 's_cached_direct',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        externalSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect((params.fetchSessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const renderable = Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_direct']).find(Boolean);
        expect(renderable?.metadata).toEqual(expect.objectContaining({
            path: '/work',
            host: 'devbox',
            externalSessionV1: expect.objectContaining({
                v: 1,
                agentId: 'claude',
            }),
        }));
    });

    it('preserves direct-session classification for cache-only renderables when an update sets externalSessionV1 to null', async () => {
        demandSessionListRow('s_cached_direct');
        replaceActiveSessionListRows([
            {
                id: 's_cached_direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'claudeConfig', configDir: '/tmp/.claude' },
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_direct_runtime_local_null',
            seq: 12,
            createdAt: 1236,
            body: {
                t: 'update-session',
                id: 's_cached_direct',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        externalSessionV1: null,
                        externalSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect((params.fetchSessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const renderable = Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_direct']).find(Boolean);
        expect(renderable?.metadata).toEqual(expect.objectContaining({
            path: '/work',
            host: 'devbox',
            externalSessionV1: expect.objectContaining({
                v: 1,
                agentId: 'claude',
            }),
        }));
    });

    it('preserves direct-session classification for cache-only renderables when an update sets externalSessionV1 to null', async () => {
        demandSessionListRow('s_cached_direct');
        replaceActiveSessionListRows([
            {
                id: 's_cached_direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'claudeConfig', configDir: '/tmp/.claude' },
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_direct_runtime_local_null_link',
            seq: 11,
            createdAt: 1235,
            body: {
                t: 'update-session',
                id: 's_cached_direct',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        externalSessionV1: null,
                        externalSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect((params.fetchSessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const renderable = Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_direct']).find(Boolean);
        expect(renderable?.metadata).toEqual(expect.objectContaining({
            path: '/work',
            host: 'devbox',
            externalSessionV1: expect.objectContaining({
                v: 1,
                agentId: 'claude',
            }),
        }));
    });

    it.each(['e2ee', 'plain'] as const)('defers hidden %s Agent state when projected pending counts are complete and unchanged', async (encryptionMode) => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_encrypted'),
            encryptionMode,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptAgentState,
                    decryptMetadata: vi.fn(),
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });
        const updateData: ApiUpdateContainer = {
            id: 'u_hidden_encrypted_projection',
            seq: 13,
            createdAt: 1238,
            body: {
                t: 'update-session',
                id: 's_hidden_encrypted',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                agentState: { version: 3, value: encryptionMode === 'plain'
                    ? JSON.stringify({ controlledByUser: false })
                    : 'encrypted-state' },
            },
        };

        await handleUpdateContainer({ ...params, updateData });
        socketApplyFrame.flushNow();

        expect(decryptAgentState).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hidden_encrypted',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentStateVersion: 1,
            agentState: {},
        }));
    });

    it('defers hidden encrypted agentState hydration when prior projected pending counts are missing and next counts are zero', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_encrypted_missing_prior_counts'),
            encryptionMode: 'e2ee',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptAgentState,
                    decryptMetadata: vi.fn(),
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });
        const updateData: ApiUpdateContainer = {
            id: 'u_hidden_encrypted_missing_prior_counts',
            seq: 14,
            createdAt: 1239,
            body: {
                t: 'update-session',
                id: 's_hidden_encrypted_missing_prior_counts',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                agentState: { version: 3, value: 'encrypted-state' },
            },
        };

        await handleUpdateContainer({ ...params, updateData });
        socketApplyFrame.flushNow();

        expect(decryptAgentState).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hidden_encrypted_missing_prior_counts',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentStateVersion: 1,
            agentState: {},
        }));
    });

    it('hydrates hidden encrypted agentState when the session is still controlled by the user', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_agent_state_controlled'),
            encryptionMode: 'e2ee',
            agentState: { controlledByUser: true, requests: {} },
            metadata: { path: '/cached', host: 'cached-host' },
            metadataVersion: 1,
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }]);
        const decryptedAgentState = { controlledByUser: true, requests: { live: { tool: 'Bash', arguments: {}, createdAt: 1 } } };
        const decryptAgentState = vi.fn(async () => ({ status: 'available', value: decryptedAgentState } satisfies AgentStateOpenResult));
        const decryptMetadata = vi.fn(async () => ({ path: '/work', host: 'devbox' }));
        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata,
                    decryptAgentStateResult: decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
            markSessionStateHydrationDeferred,
        });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hidden_agent_state_controlled',
                seq: 14,
                createdAt: 1_239,
                body: {
                    t: 'update-session',
                    id: 's_hidden_agent_state_controlled',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    metadata: { version: 2, value: 'encrypted-metadata' },
                    agentState: { version: 2, value: 'encrypted-agent-state' },
                },
            },
        });

        expect(decryptAgentState).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith('s_hidden_agent_state_controlled');
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession).toEqual(expect.objectContaining({
            agentState: decryptedAgentState,
            agentStateVersion: 2,
            metadata: { path: '/cached', host: 'cached-host' },
            metadataVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
    });

    it('hydrates hidden encrypted agentState when projected pending work increases', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_agent_state_pending_increase'),
            encryptionMode: 'e2ee',
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }]);
        const decryptedAgentState = { controlledByUser: false, requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } } };
        const decryptAgentState = vi.fn(async () => ({ status: 'available', value: decryptedAgentState } satisfies AgentStateOpenResult));
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata: vi.fn(async () => ({ path: '/work', host: 'devbox' })),
                    decryptAgentStateResult: decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hidden_agent_state_pending_increase',
                seq: 15,
                createdAt: 1_240,
                body: {
                    t: 'update-session',
                    id: 's_hidden_agent_state_pending_increase',
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    agentState: { version: 2, value: 'encrypted-agent-state' },
                },
            },
        });

        expect(decryptAgentState).toHaveBeenCalledTimes(1);
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession).toEqual(expect.objectContaining({
            agentState: decryptedAgentState,
            agentStateVersion: 2,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
        }));
    });

    it('keeps cache-only content stable while timestamp-only observations advance', async () => {
        vi.useFakeTimers();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        replaceActiveSessionListRows([
            {
                id: 's_cached_activity_timestamp_gate',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_timestamp_gate',
                    {
                        type: 'activity',
                        id: 's_cached_activity_timestamp_gate',
                        sessionId: 's_cached_activity_timestamp_gate',
                        active: true,
                        activeAt: 20_000,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_timestamp_gate']).find(Boolean)).toEqual(
            expect.objectContaining({
                activeAt: 1,
                thinkingAt: 1,
                updatedAt: 1,
            }),
        );
        expect(sessionRuntimeObservations.read({ serverId: getActiveServerSnapshot().serverId,
            sessionId: 's_cached_activity_timestamp_gate' })?.activeAt).toBe(20_000);
        expect(syncPerformanceTelemetry.snapshot().events.some((entry) => entry.name === 'sync.socket.sessions.activity.flush')).toBe(false);

        syncPerformanceTelemetry.reset();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_timestamp_gate',
                    {
                        type: 'activity',
                        id: 's_cached_activity_timestamp_gate',
                        sessionId: 's_cached_activity_timestamp_gate',
                        active: true,
                        activeAt: 61_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_timestamp_gate']).find(Boolean)).toEqual(
            expect.objectContaining({
                activeAt: 1,
                thinkingAt: 1,
                updatedAt: 1,
            }),
        );
        expect(sessionRuntimeObservations.read({ serverId: getActiveServerSnapshot().serverId,
            sessionId: 's_cached_activity_timestamp_gate' })?.activeAt).toBe(61_001);
        expect(syncPerformanceTelemetry.snapshot().events.some((entry) => entry.name === 'sync.socket.sessions.activity.flush')).toBe(false);

        await vi.advanceTimersByTimeAsync(16);

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_timestamp_gate']).find(Boolean)).toEqual(
            expect.objectContaining({
                activeAt: 1,
                thinkingAt: 1,
                updatedAt: 1,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('retains cache-only content timestamps while observing a heartbeat behind newer durable content', async () => {
        vi.useFakeTimers();
        replaceActiveSessionListRows([
            {
                id: 's_cached_activity_heartbeat',
                seq: 1,
                createdAt: 1,
                updatedAt: 100_000,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_heartbeat',
                    {
                        type: 'activity',
                        id: 's_cached_activity_heartbeat',
                        sessionId: 's_cached_activity_heartbeat',
                        active: true,
                        activeAt: 70_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_heartbeat']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 1,
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                updatedAt: 100_000,
            }),
        );

        await vi.advanceTimersByTimeAsync(16);

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_heartbeat']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 1,
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                updatedAt: 100_000,
            }),
        );
        expect(sessionRuntimeObservations.read({ serverId: getActiveServerSnapshot().serverId,
            sessionId: 's_cached_activity_heartbeat' })?.activeAt).toBe(70_001);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('target-hydrates visible cache-only renderables after activity patches', async () => {
        vi.useFakeTimers();
        const serverId = String(getActiveServerSnapshot().serverId);
        replaceActiveSessionListRows([
            {
                id: 's_cached_activity_visible',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 1,
                presence: 1,
            },
        ]);
        markSessionSurfaceVisible('s_cached_activity_visible', serverId);
        const applySessions = vi.fn();
        const hydrateSessionById = vi.fn();
        const flushParams: Parameters<typeof flushActivityUpdates>[0] & {
            hydrateSessionById: (sessionId: string, reason: 'socket-update-missing-session') => void;
        } = {
            updates: new Map([
                [
                    's_cached_activity_visible',
                    {
                        type: 'activity',
                        id: 's_cached_activity_visible',
                        sessionId: 's_cached_activity_visible',
                        active: true,
                        activeAt: 70_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
            sourceServerId: serverId,
            hydrateSessionById,
        };

        flushActivityUpdates(flushParams);

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_visible']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1,
                thinking: false,
                thinkingAt: 1,
                presence: 1,
                updatedAt: 1,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_activity_visible', 'socket-update-missing-session');

        await vi.advanceTimersByTimeAsync(16);

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_visible']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 70_001,
                thinking: true,
                thinkingAt: 70_001,
                presence: 'online',
                updatedAt: 1,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('skips queued cache-only activity patches when targeted hydration materializes the session before flush', async () => {
        vi.useFakeTimers();
        const serverId = String(getActiveServerSnapshot().serverId);
        replaceActiveSessionListRows([
            {
                id: 's_cached_activity_hydrated_before_flush',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 1,
                presence: 1,
            },
        ]);
        markSessionSurfaceVisible('s_cached_activity_hydrated_before_flush', serverId);
        const applySessions = vi.fn();
        const hydrateSessionById = vi.fn();

        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_hydrated_before_flush',
                    {
                        type: 'activity',
                        id: 's_cached_activity_hydrated_before_flush',
                        sessionId: 's_cached_activity_hydrated_before_flush',
                        active: true,
                        activeAt: 70_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
            sourceServerId: serverId,
            hydrateSessionById,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith(
            's_cached_activity_hydrated_before_flush',
            'socket-update-missing-session',
        );
        storage.getState().applySessions([
            {
                ...buildSession('s_cached_activity_hydrated_before_flush'),
                serverId,
                active: false,
                activeAt: 500,
                thinking: false,
                thinkingAt: 500,
                updatedAt: 500,
            },
        ]);

        await vi.advanceTimersByTimeAsync(16);

        expect(storage.getState().sessions.s_cached_activity_hydrated_before_flush).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 500,
                thinking: false,
                thinkingAt: 500,
                updatedAt: 500,
            }),
        );
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_hydrated_before_flush']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 500,
                thinking: false,
                thinkingAt: 500,
                updatedAt: 500,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('coalesces cache-only activity renderable patches before touching the list store', async () => {
        vi.useFakeTimers();
        replaceActiveSessionListRows([
            {
                id: 's_cached_activity_coalesced_one',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp/one', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
            {
                id: 's_cached_activity_coalesced_two',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp/two', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_coalesced_one',
                    {
                        type: 'activity',
                        id: 's_cached_activity_coalesced_one',
                        sessionId: 's_cached_activity_coalesced_one',
                        active: true,
                        activeAt: 20,
                        thinking: true,
                    },
                ],
                [
                    's_cached_activity_coalesced_two',
                    {
                        type: 'activity',
                        id: 's_cached_activity_coalesced_two',
                        sessionId: 's_cached_activity_coalesced_two',
                        active: true,
                        activeAt: 21,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_coalesced_one']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            }),
        );
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_coalesced_two']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(16);

        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_coalesced_one']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 20,
                thinking: true,
                thinkingAt: 20,
                presence: 'online',
            }),
        );
        expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows['s_cached_activity_coalesced_two']).find(Boolean)).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 21,
                thinking: true,
                thinkingAt: 21,
                presence: 'online',
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('retains hydrated content timestamps while observing a heartbeat behind newer durable content', () => {
        storage.getState().applySessions([
            {
                ...buildSession('s_hydrated_activity_heartbeat'),
                updatedAt: 100_000,
                active: true,
                activeAt: 1,
                thinking: true,
                thinkingAt: 1,
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_hydrated_activity_heartbeat',
                    {
                        type: 'activity',
                        id: 's_hydrated_activity_heartbeat',
                        sessionId: 's_hydrated_activity_heartbeat',
                        active: true,
                        activeAt: 70_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(applySessions).not.toHaveBeenCalled();
        expect(storage.getState().sessions.s_hydrated_activity_heartbeat).toMatchObject({
            activeAt: 1, thinkingAt: 1, updatedAt: 100_000,
        });
        expect(sessionRuntimeObservations.read({ serverId: getActiveServerSnapshot().serverId,
            sessionId: 's_hydrated_activity_heartbeat' })?.activeAt).toBe(70_001);
    });

    it('does not regress hydrated activity timestamps from older timestamp-only updates', () => {
        storage.getState().applySessions([
            {
                ...buildSession('s_hydrated_activity_stale_heartbeat'),
                updatedAt: 100_000,
                active: true,
                activeAt: 70_001,
                thinking: true,
                thinkingAt: 70_001,
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_hydrated_activity_stale_heartbeat',
                    {
                        type: 'activity',
                        id: 's_hydrated_activity_stale_heartbeat',
                        sessionId: 's_hydrated_activity_stale_heartbeat',
                        active: true,
                        activeAt: 60_000,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('records activity flush telemetry for real hydrated and cache-only state changes', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        storage.getState().applySessions([{ ...buildSession('s_hydrated_activity'), thinking: true, thinkingAt: 1 }]);
        replaceActiveSessionListRows([
            {
                id: 's_cached_activity_timestamp_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_hydrated_activity',
                    {
                        type: 'activity',
                        id: 's_hydrated_activity',
                        sessionId: 's_hydrated_activity',
                        active: true,
                        activeAt: 20,
                        thinking: false,
                    },
                ],
                [
                    's_cached_activity_timestamp_only',
                    {
                        type: 'activity',
                        id: 's_cached_activity_timestamp_only',
                        sessionId: 's_cached_activity_timestamp_only',
                        active: true,
                        activeAt: 61_001,
                        thinking: false,
                    },
                ],
            ]),
            applySessions,
        });

        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((entry) => entry.name === 'sync.socket.sessions.activity.flush');
        expect(event?.fields).toEqual(expect.objectContaining({
            updates: 2,
            sessions: 1,
            renderablePatches: 1,
        }));
    });

    it('defers hidden encrypted metadata and Agent state while applying activity projections', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_metadata'),
            encryptionMode: 'e2ee',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptMetadata = vi.fn(async () => ({ path: '/work', host: 'devbox' }));
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptAgentState,
                    decryptMetadata,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
            markSessionStateHydrationDeferred,
        } as Partial<HandleUpdateContainerBaseParams>);
        const updateData: ApiUpdateContainer = {
            id: 'u_hidden_encrypted_metadata_projection',
            seq: 14,
            createdAt: 1239,
            body: {
                t: 'update-session',
                id: 's_hidden_metadata',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: 1238,
                latestReadyEventSeq: 8,
                latestReadyEventAt: 1238,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1238,
                meaningfulActivityAt: 1238,
                metadata: { version: 3, value: 'encrypted-metadata' },
                agentState: { version: 4, value: 'encrypted-agent-state' },
            },
        };

        await handleUpdateContainer({ ...params, updateData });

        expect(decryptMetadata).not.toHaveBeenCalled();
        // Hidden encrypted agentState must be deferred: it is never decrypted in this path.
        expect(decryptAgentState).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hidden_metadata',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 1238,
            latestReadyEventSeq: 8,
            latestReadyEventAt: 1238,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1238,
            meaningfulActivityAt: 1238,
            metadataVersion: 1,
            metadata: { path: '/tmp', host: 'localhost' },
            agentStateVersion: 1,
            agentState: {},
        }));
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith('s_hidden_metadata');
    });
});
