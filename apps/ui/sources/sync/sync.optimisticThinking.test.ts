import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';
import { createSocketIoAckTimeoutError } from '@happier-dev/protocol/rpcErrors';

type EndpointSupervisorLookup = typeof import('@/sync/runtime/connectivity/endpointSupervisorPool').getEndpointSupervisorForServer;
type EndpointSupervisorAcquire = typeof import('@/sync/runtime/connectivity/endpointSupervisorPool').acquireEndpointSupervisor;
type AssertServerReachabilityAuthenticated = typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool').assertServerReachabilityAuthenticated;
type EnsureSessionRuntimeForPendingInput = typeof import('@/sync/ops').ensureSessionRuntimeForPendingInput;

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: appStateAddListener as any,
                                            },
                                        }
    );
});

const getEndpointSupervisorForServerMock = vi.hoisted(() => vi.fn<EndpointSupervisorLookup>(() => null));
const acquireEndpointSupervisorMock = vi.hoisted(() => vi.fn<EndpointSupervisorAcquire>());
vi.mock('@/sync/runtime/connectivity/endpointSupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/endpointSupervisorPool')>();
    return {
        ...actual,
        getEndpointSupervisorForServer: (...args: Parameters<typeof actual.getEndpointSupervisorForServer>) =>
            getEndpointSupervisorForServerMock(...args),
        acquireEndpointSupervisor: (...args: Parameters<typeof actual.acquireEndpointSupervisor>) =>
            acquireEndpointSupervisorMock(...args),
    };
});

const assertServerReachabilityAuthenticatedMock = vi.hoisted(() => vi.fn<AssertServerReachabilityAuthenticated>());
const runtimeFetchWithServerReachabilityMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        assertServerReachabilityAuthenticated: (...args: Parameters<typeof actual.assertServerReachabilityAuthenticated>) =>
            assertServerReachabilityAuthenticatedMock(...args),
    };
});

// System-boundary mock: scoped retry behavior is exercised through the real Sync scheduler and
// credential resolver; only the final HTTP transport is replaced so both target servers are deterministic.
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchWithServerReachabilityMock,
}));

const ensureSessionRuntimeForPendingInputMock = vi.hoisted(() => vi.fn<EnsureSessionRuntimeForPendingInput>(async () => ({ type: 'success' as const })));
vi.mock('@/sync/ops', () => ({
    ensureSessionRuntimeForPendingInput: ensureSessionRuntimeForPendingInputMock,
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from './domains/state/storage';
import { useSessionPendingMessages } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { HappyError } from '@/utils/errors/errors';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    loadPendingOutboxForSession,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import {
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
} from '@/sync/engine/pending/pendingQueueV2';
import { resolveSessionRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import {
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setRuntimeFetch } from '@/sync/http/client';

const initialStorageState = storage.getState();

function createSession(params: { sessionId: string; metadata?: Session['metadata'] }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: params.metadata ?? null,
        metadataVersion: 0,
        agentState: null,
        // Mark as ready to avoid the 10s wait-for-ready timeout.
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function pendingOutboxFixture(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    operation?: 'enqueue' | 'cancel';
}>) {
    const rawRecord = {
        role: 'user' as const,
        content: { type: 'text' as const, text: params.text },
        meta: {},
    };
    return {
        sessionId: params.sessionId,
        localId: params.localId,
        createdAt: 111,
        text: params.text,
        rawRecord,
        operation: params.operation,
        request: {
            v: 1 as const,
            body: JSON.stringify({
                localId: params.localId,
                content: { t: 'plain', v: rawRecord },
                messageRole: 'user',
            }),
        },
    };
}

async function flushPendingOutboxRetryMicrotasks(): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
        await Promise.resolve();
        // fake-indexeddb commits transactions on the host's immediate queue, not the Promise
        // queue. Alternate both queues so the retry can read, mutate, and commit durably.
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

function createRpcMethodNotAvailableError(): RpcError {
    return new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
}

function createFallbackSafeSessionRpcErrors(): Error[] {
    return [
        new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE),
        new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND),
        new Error('Socket connect timeout'),
        new Error('connect_error: legacy daemon reconnecting'),
        new Error('read ECONNRESET'),
        new Error('connect ECONNREFUSED 127.0.0.1:3005'),
    ];
}

function usePendingSchedulerFakeTimers(): void {
    // Fake only the retry scheduler's clock. IndexedDB's test implementation commits through
    // setImmediate; faking that system-boundary queue can strand an open transaction forever.
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
}

function createAuthFailedEndpointSupervisor(): ManagedEndpointSupervisor {
    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: () => ({
            phase: 'auth_failed',
            reason: 'auth_invalid',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'expired token',
            lastProbe: {
                status: 'auth_failed',
                statusCode: 401,
                errorMessage: 'expired token',
            },
        }),
        subscribe: () => vi.fn(),
    };
}

function createAuthProbeEndpointSupervisor(): ManagedEndpointSupervisor {
    let phase: 'online' | 'connecting' | 'auth_failed' = 'online';
    let lastProbe: ReturnType<ManagedEndpointSupervisor['getState']>['lastProbe'] = { status: 'ready' };
    const listeners = new Set<(state: ReturnType<ManagedEndpointSupervisor['getState']>) => void>();
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase,
        reason: phase === 'auth_failed' ? 'auth_invalid' : phase === 'online' ? 'initial_connect' : 'initial_connect',
        attempt: phase === 'auth_failed' ? 2 : 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: phase === 'auth_failed' ? Date.now() : null,
        lastErrorMessage: phase === 'auth_failed' ? 'expired token' : null,
        lastProbe,
    });
    const publish = () => {
        const state = readState();
        listeners.forEach((listener) => listener(state));
    };

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(() => {
            phase = 'connecting';
            publish();
            phase = 'auth_failed';
            lastProbe = {
                status: 'auth_failed',
                statusCode: 401,
                errorMessage: 'expired token',
            };
            publish();
        }),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listeners.add(listener);
            listener(readState());
            return () => listeners.delete(listener);
        },
    };
}

function createReadyEndpointSupervisor(): ManagedEndpointSupervisor {
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase: 'online',
        reason: 'initial_connect',
        attempt: 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
        lastProbe: { status: 'ready' },
    });

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listener(readState());
            return vi.fn();
        },
    };
}

describe('sync.sendMessage optimistic thinking', () => {
    it('releases the pending retry slot when the storage boundary stays unavailable', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 'pending-storage-failure';
            const localId = 'pending-storage-failure-local';
            const profile = upsertServerProfile({ serverUrl: 'https://pending-storage-failure.example.test', name: 'Storage failure' });
            const outboxScope = { serverId: profile.id, accountId: 'account-storage-failure' };
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);
            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
                token: tokenForSub(outboxScope.accountId),
                secret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
            });
            runtimeFetchWithServerReachabilityMock.mockResolvedValue(new Response(null, { status: 200 }));
            const { MMKV } = await import('react-native-mmkv');
            const key = scopedSessionLocalStateKey('session-pending-outbox-v1', outboxScope);
            let failedReads = 0;
            const originalGetString = MMKV.prototype.getString;
            vi.spyOn(MMKV.prototype, 'getString').mockImplementation(function (this: InstanceType<typeof MMKV>, readKey: string) {
                if (readKey === key) {
                    failedReads += 1;
                    throw new Error('Storage unavailable');
                }
                return originalGetString.call(this, readKey);
            });
            const { sync } = await import('./sync');
            const retries = (sync as unknown as { pendingOutboxOperationRetryTimers: Map<string, unknown> }).pendingOutboxOperationRetryTimers;
            sync.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
            expect(retries.size).toBe(1);
            await vi.advanceTimersByTimeAsync(1_000);
            await flushPendingOutboxRetryMicrotasks();
            expect(failedReads).toBeGreaterThan(0);
            expect(retries.size).toBe(0);
            sync.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
            expect(retries.size).toBe(1);
            await vi.advanceTimersByTimeAsync(1_000);
            await flushPendingOutboxRetryMicrotasks();
            expect(retries.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        setRuntimeFetch(async () => Response.json(buildServerFeaturesResponse()));
        storage.setState(initialStorageState, true);
        const activeScope = {
            serverId: getActiveServerSnapshot().serverId,
            accountId: 'sync-test-account',
        } as const;
        storage.getState().activateProfileScope(activeScope);
        appStateAddListener.mockClear();
        getEndpointSupervisorForServerMock.mockReset();
        getEndpointSupervisorForServerMock.mockReturnValue(null);
        acquireEndpointSupervisorMock.mockReset();
        acquireEndpointSupervisorMock.mockResolvedValue({
            supervisor: createReadyEndpointSupervisor(),
            release: vi.fn(async () => {}),
        });
        assertServerReachabilityAuthenticatedMock.mockReset();
        runtimeFetchWithServerReachabilityMock.mockReset();
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url?: string }) =>
            Response.json(request.url?.endsWith('/v1/features')
                ? buildServerFeaturesResponse()
                : { requestedAction: { v: 1, kind: 'enqueue' } }),
        );
        ensureSessionRuntimeForPendingInputMock.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
    });

    it('preserves optimistic thinking after a successful ACK/commit (until lifecycle clears)', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const promise = sync.sendMessage(sessionId, 'hello');

        // sendMessage marks optimistic thinking before the first await.
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await promise;

        // ACK means the user message was committed; it does not mean the agent turn is complete.
        // Keep optimistic thinking so the UI can still show "processing" and expose abort controls
        // until we see a terminal lifecycle marker (task_complete / turn_aborted) or the timeout fires.
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_complete',
            id: 'task-1',
            createdAt: Date.now(),
        });
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('notifies local pending projection after the pending row exists', async () => {
        const sessionId = 's_local_pending_projection_callback';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: 'local-visible-id',
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const projectionEvents: Array<Readonly<{ localId: string; pendingIds: readonly string[] }>> = [];

        await sync.sendMessage(sessionId, 'hello', undefined, undefined, {
            localId: 'local-visible-id',
            onLocalPendingProjectionCreated: ({ localId }) => {
                projectionEvents.push({
                    localId,
                    pendingIds: (storage.getState().sessionPending[sessionId]?.messages ?? []).map((message) => message.id),
                });
            },
        });

        expect(projectionEvents).toEqual([{
            localId: 'local-visible-id',
            pendingIds: ['local-visible-id'],
        }]);
    });

    it('establishes own-send tail intent before mutating an existing durable pending action', async () => {
        const sessionId = 's_pending_send_now_live_tail';
        const localId = 'pending-send-now-local';
        const outboxScope = storage.getState().profileScope!;
        const pending = pendingOutboxFixture({
            sessionId,
            localId,
            text: 'send the queued prompt now',
        });
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
        }]);
        (await savePendingOutboxMessage(pending, outboxScope));
        (await replayPersistedPendingOutboxForSession(sessionId, outboxScope));

        const { sync } = await import('./sync');
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(7));
        sync.onSessionViewportChange(sessionId, {
            isPinned: false,
            offsetY: 420,
            shouldPersistViewport: false,
            shouldRestoreViewport: true,
        });
        const markLiveTailIntent = vi.spyOn(sync, 'markSessionLiveTailIntent');
        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => {
            if (init?.method === 'PATCH') {
                expect(markLiveTailIntent).toHaveBeenCalledTimes(1);
                expect(sync.getSessionViewport(sessionId)).toMatchObject({
                    isPinned: true,
                    offsetY: 0,
                    source: 'default',
                    anchor: null,
                });
                return Response.json({ didUpdate: true });
            }
            return Response.json({});
        });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId,
            createdAt: pending.createdAt,
            rawRecord: pending.rawRecord,
            text: pending.text,
            deliveryIntent: 'interrupt_and_send',
        })).resolves.toMatchObject({
            type: 'retry_scheduled',
            persistence: 'pending',
        });

        expect(markLiveTailIntent).toHaveBeenCalledTimes(1);
    });

    it('refreshes the exact pending session and surfaces an actionable error when an action loses its mutation race', async () => {
        const sessionId = 's_pending_action_conflict';
        const localId = 'pending-action-conflict-local';
        const outboxScope = storage.getState().profileScope!;
        const pending = pendingOutboxFixture({ sessionId, localId, text: 'steer me now' });
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
        }]);
        (await savePendingOutboxMessage(pending, outboxScope));
        (await replayPersistedPendingOutboxForSession(sessionId, outboxScope));

        const { sync } = await import('./sync');
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const requests: Array<{ path: string; method: string }> = [];
        vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
            requests.push({ path, method: init?.method ?? 'GET' });
            if (init?.method === 'PATCH') {
                return Response.json({ error: 'action-conflict' }, { status: 409 });
            }
            return Response.json({ pending: [], discarded: [] });
        });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId,
            createdAt: pending.createdAt,
            rawRecord: pending.rawRecord,
            text: pending.text,
            deliveryIntent: 'steer_now',
        })).rejects.toMatchObject({
            code: 'action-conflict',
            message: expect.stringContaining('changed'),
        });

        expect(requests).toEqual([
            { path: `/v2/sessions/${sessionId}/pending/${localId}/action`, method: 'PATCH' },
            { path: `/v2/sessions/${sessionId}/pending?includeDiscarded=1`, method: 'GET' },
        ]);
    });

    it.each([
        { status: 404, code: 'not-found' },
        { status: 409, code: 'action-conflict' },
    ])('reconciles stale pending rows for every requested-action caller on $code', async ({ status, code }) => {
        const sessionId = 's_pending_stale_action';
        const localId = 'stale-pending-local';
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
        }]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: 'already materialized',
            rawRecord: { role: 'user', content: { type: 'text', text: 'already materialized' } },
        });
        const { sync } = await import('./sync');
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(7));
        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => {
            if (init?.method === 'PATCH') return Response.json({ error: code }, { status });
            return Response.json({ pending: [] });
        });

        await expect(sync.updatePendingRequestedAction(
            sessionId, localId, { v: 1, kind: 'enqueue' }, { resumeWhenAvailable: true },
        )).rejects.toMatchObject({ code });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
    });

    it('hydrates a missing active session before sending the user message', async () => {
        const sessionId = 's_missing_then_hydrated';

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        const ensureSessionVisibleForMessageRouteSpy = vi
            .spyOn(sync as any, 'ensureSessionVisibleForMessageRoute')
            .mockImplementation(async () => {
                storage.getState().applySessions([createSession({ sessionId })]);
                return true;
            });

        await sync.sendMessage(sessionId, 'hello after hydrate');

        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledWith(sessionId, { forceRefresh: true });
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
            }),
            expect.anything(),
        );
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();
    });

    it('removes the local pending row when socket fallback sees an auth-failed endpoint', async () => {
        const sessionId = 's_stale_auth_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        getEndpointSupervisorForServerMock.mockReturnValue(createAuthFailedEndpointSupervisor());

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });
    });

    it('forces endpoint auth convergence before user no-ack fallback restores the draft', async () => {
        const sessionId = 's_stale_auth_probe_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        const supervisor = createAuthProbeEndpointSupervisor();
        getEndpointSupervisorForServerMock.mockReturnValue(supervisor);

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(supervisor.invalidate).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });
    });

    it('acquires an endpoint supervisor before probing auth for user no-ack fallback', async () => {
        const sessionId = 's_stale_auth_probe_no_existing_supervisor';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        const supervisor = createAuthProbeEndpointSupervisor();
        acquireEndpointSupervisorMock.mockResolvedValue({
            supervisor,
            release: vi.fn(async () => {}),
        });

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(acquireEndpointSupervisorMock).toHaveBeenCalledTimes(1);
        expect(supervisor.invalidate).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
        });
    });

    it('uses server reachability auth state before user no-ack fallback restores the draft', async () => {
        const sessionId = 's_stale_auth_reachability_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        assertServerReachabilityAuthenticatedMock.mockImplementation(() => {
            throw new HappyError('Authentication required', false, {
                kind: 'auth',
                code: 'not_authenticated',
                status: 401,
            });
        });

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(assertServerReachabilityAuthenticatedMock).toHaveBeenCalled();
        expect(acquireEndpointSupervisorMock).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
        });
    });

    it('prefers session runtime RPC for active sessions so steering-capable agents receive the user message directly', async () => {
        const sessionId = 's_active_runtime_rpc';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'steer this');

        expect(sessionRpcSpy).toHaveBeenCalledWith(
            sessionId,
            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
            expect.objectContaining({
                text: 'steer this',
                localId: expect.any(String),
                meta: expect.objectContaining({
                    sentFrom: expect.any(String),
                    permissionMode: 'default',
                }),
            }),
            { timeoutMs: 7_500 },
        );
        expect(emitWithAck).not.toHaveBeenCalled();

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.map((message) => message.text)).toEqual(['steer this']);
        expect(pending.map((message) => message.deliveryStatus)).toEqual(['accepted']);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        sessionRpcSpy.mockRestore();
    });

    it('wakes an apparently active session with fresh user-request provenance when runtime RPC falls back to a durable commit', async () => {
        const sessionId = 's_active_runtime_rpc_post_boot_fallback';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: { machineId: 'm1', path: '/repo', flavor: 'codex' } as any,
        })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-post-boot',
            seq: 42,
            localId: null,
            didWrite: true,
        })) as any;
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        const result = await sync.sendMessage(sessionId, 'retry after daemon replacement');

        expect(result).toMatchObject({ persistence: 'transcript_committed' });
        expect(ensureSessionRuntimeForPendingInputMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId,
            initialTranscriptAfterSeq: 41,
            executionAuthorization: {
                provenance: 'user_request',
                requestId: expect.any(String),
            },
        }));
    });

    it('preserves whitespace-distinct opaque local ids through durable commit and execution authorization', async () => {
        const sessionId = 's_opaque_execution_authorization_ids';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: { machineId: 'm1', path: '/repo', flavor: 'codex' } as any,
        })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        let seq = 40;
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: `m-opaque-${seq}`,
            seq: ++seq,
            localId: null,
            didWrite: true,
        })) as any;
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        const opaqueLocalIds = [' request-1', 'request-1 '] as const;
        for (const localId of opaqueLocalIds) {
            await sync.sendMessage(sessionId, 'retry after daemon replacement', undefined, undefined, { localId });
        }

        const sentLocalIds = (emitWithAck.mock.calls as Array<[string, { localId?: string }]>).map(([, payload]) => payload.localId);
        expect(sentLocalIds).toEqual(opaqueLocalIds);
        expect(ensureSessionRuntimeForPendingInputMock.mock.calls.map((call) => call[0]?.executionAuthorization?.requestId)).toEqual(opaqueLocalIds);
        expect(new Set(ensureSessionRuntimeForPendingInputMock.mock.calls.map((call) => call[0]?.executionAuthorization?.requestId))).toHaveLength(2);
    });

    it('keeps a runtime-accepted local pending message when server pending refresh is empty', async () => {
        const sessionId = 's_active_runtime_rpc_pending_refresh';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(
            new Response(JSON.stringify({ pending: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck: vi.fn(),
            send: vi.fn(),
        });

        await sync.sendMessage(
            sessionId,
            'first prompt remains visible',
            undefined,
            undefined,
            { localId: 'first-turn-local' },
        );
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
            'first-turn-local',
        ]);

        await sync.fetchPendingMessages(sessionId);

        expect(requestSpy).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
            { method: 'GET', cache: 'no-store' },
        );
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'first-turn-local',
                localId: 'first-turn-local',
                deliveryStatus: 'accepted',
                text: 'first prompt remains visible',
            }),
        ]);

        sessionRpcSpy.mockRestore();
        requestSpy.mockRestore();
    });

    it('reconciles a server-delivering row when its committed twin arrives without pending-changed', async () => {
        const sessionId = 's_server_pending_commit_without_receipt';
        const localId = 'delivered-local-id';
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
        }]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 1_000,
            updatedAt: 1_100,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_delivering',
            text: 'already delivered',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'already delivered' },
                meta: {},
            },
        });
        const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(
            Response.json({ pending: [] }),
        );
        const { sync } = await import('./sync');

        (sync as any).applyMessages(sessionId, [{
            id: 'committed-message-id',
            seq: 1,
            localId,
            createdAt: 1_200,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: 'already delivered' },
        }]);

        await vi.waitFor(() => {
            expect(requestSpy).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
                { method: 'GET', cache: 'no-store' },
            );
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
        });
    });

    it('reconciles a mounted server-delivering row when the settlement repeats an unchanged committed twin', async () => {
        const sessionId = 's_server_pending_repeated_commit_without_receipt';
        const localId = 'repeated-delivered-local-id';
        const committed = {
            id: 'already-committed-message-id',
            seq: 1,
            localId,
            createdAt: 1_200,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: 'already delivered' },
        } as const;
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
        }]);
        storage.getState().applyMessages(sessionId, [committed]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 1_000,
            updatedAt: 1_100,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_delivering',
            text: 'already delivered',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'already delivered' },
                meta: {},
            },
        });
        const mounted = await renderHook(() => useSessionPendingMessages(sessionId));
        expect(mounted.getCurrent().messages.map((message) => message.localId)).toEqual([localId]);

        const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(
            Response.json({ pending: [] }),
        );
        const { sync } = await import('./sync');

        await act(async () => {
            (sync as any).applyMessages(sessionId, [committed]);
            await vi.waitFor(() => {
                expect(requestSpy).toHaveBeenCalledWith(
                    `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
                    { method: 'GET', cache: 'no-store' },
                );
            });
        });

        expect(mounted.getCurrent().messages).toEqual([]);
        await mounted.unmount();
    });

    it('replays identical scoped enqueue identities independently through the real Sync scheduler', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 'same-session';
            const localId = 'same-local';
            const serverAUrl = 'https://pending-a.example.test';
            const serverBUrl = 'https://pending-b.example.test';
            const profileA = upsertServerProfile({ serverUrl: serverAUrl, name: 'Pending A' });
            const profileB = upsertServerProfile({ serverUrl: serverBUrl, name: 'Pending B' });
            const scopeA = { serverId: profileA.id, accountId: 'account-a' } as const;
            const scopeB = { serverId: profileB.id, accountId: 'account-b' } as const;
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);
            (await savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'scope A' }), scopeA));
            (await savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'scope B' }), scopeB));

            runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url?: string; init?: RequestInit }) => {
                if (request.url?.endsWith('/v1/features')) {
                    return Response.json(buildServerFeaturesResponse());
                }
                const body = JSON.parse(String(request.init?.body)) as { localId: string };
                return Response.json({
                    terminal: true,
                    requestedAction: { v: 1, kind: 'enqueue' },
                    message: { id: `message-${body.localId}`, seq: 1, localId: body.localId },
                });
            });

            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => ({
                token: tokenForSub(serverUrl === serverAUrl ? 'account-a' : 'account-b'),
                secret: Buffer.from(new Uint8Array(32).fill(serverUrl === serverAUrl ? 1 : 2)).toString('base64url'),
            }));
            const { sync } = await import('./sync');
            await expect(resolveSessionRequestForServerAccountScope({
                scope: scopeA,
                activeRequest: apiSocket.request,
            })).resolves.toEqual(expect.any(Function));
            await expect(resolveSessionRequestForServerAccountScope({
                scope: scopeB,
                activeRequest: apiSocket.request,
            })).resolves.toEqual(expect.any(Function));
            // Replay A, then B, matching the order produced by a reload followed by a server switch.
            for (const replayLocalId of (await replayPersistedPendingOutboxForSession(sessionId, scopeA))) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeA });
            }
            for (const replayLocalId of (await replayPersistedPendingOutboxForSession(sessionId, scopeB))) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeB });
            }

            await vi.advanceTimersByTimeAsync(1_000);
            await flushPendingOutboxRetryMicrotasks();

            const posts = runtimeFetchWithServerReachabilityMock.mock.calls
                .map(([request]) => request as { serverUrl: string; init?: RequestInit })
                .filter((request) => request.init?.method === 'POST');
            expect(posts).toHaveLength(2);
            expect(posts.map((request) => request.serverUrl).sort()).toEqual([serverAUrl, serverBUrl].sort());
            expect(posts.map((request) => String(request.init?.body)).sort()).toEqual([
                pendingOutboxFixture({ sessionId, localId, text: 'scope A' }).request.body,
                pendingOutboxFixture({ sessionId, localId, text: 'scope B' }).request.body,
            ].sort());
            expect((await loadPendingOutboxForSession(sessionId, scopeA))).toEqual([]);
            expect((await loadPendingOutboxForSession(sessionId, scopeB))).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('replays identical scoped cancellations independently through the real Sync scheduler', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 'same-cancel-session';
            const localId = 'same-cancel-local';
            const serverAUrl = 'https://cancel-a.example.test';
            const serverBUrl = 'https://cancel-b.example.test';
            const profileA = upsertServerProfile({ serverUrl: serverAUrl, name: 'Cancel A' });
            const profileB = upsertServerProfile({ serverUrl: serverBUrl, name: 'Cancel B' });
            const scopeA = { serverId: profileA.id, accountId: 'cancel-account-a' } as const;
            const scopeB = { serverId: profileB.id, accountId: 'cancel-account-b' } as const;
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);
            (await savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'cancel A', operation: 'cancel' }), scopeA));
            (await savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'cancel B', operation: 'cancel' }), scopeB));

            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => ({
                token: tokenForSub(serverUrl === serverAUrl ? 'cancel-account-a' : 'cancel-account-b'),
                secret: Buffer.from(new Uint8Array(32).fill(serverUrl === serverAUrl ? 3 : 4)).toString('base64url'),
            }));
            const { sync } = await import('./sync');
            await expect(resolveSessionRequestForServerAccountScope({
                scope: scopeA,
                activeRequest: apiSocket.request,
            })).resolves.toEqual(expect.any(Function));
            await expect(resolveSessionRequestForServerAccountScope({
                scope: scopeB,
                activeRequest: apiSocket.request,
            })).resolves.toEqual(expect.any(Function));
            // Replay A, then B, matching the order produced by a reload followed by a server switch.
            for (const replayLocalId of (await replayPersistedPendingOutboxForSession(sessionId, scopeA))) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeA });
            }
            for (const replayLocalId of (await replayPersistedPendingOutboxForSession(sessionId, scopeB))) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeB });
            }

            await vi.advanceTimersByTimeAsync(1_000);
            await flushPendingOutboxRetryMicrotasks();

            const deletes = runtimeFetchWithServerReachabilityMock.mock.calls
                .map(([request]) => request as { serverUrl: string; url: string; init?: RequestInit })
                .filter((request) => request.init?.method === 'DELETE');
            expect(deletes).toHaveLength(2);
            expect(deletes.map((request) => request.serverUrl).sort()).toEqual([serverAUrl, serverBUrl].sort());
            expect(deletes.every((request) => request.url.endsWith(`/v2/sessions/${sessionId}/pending/${localId}`))).toBe(true);
            expect((await loadPendingOutboxForSession(sessionId, scopeA))).toEqual([]);
            expect((await loadPendingOutboxForSession(sessionId, scopeB))).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ['enqueue', 'stale_profile'],
        ['cancel', 'stale_profile'],
        ['enqueue', 'cleared_profile'],
        ['cancel', 'cleared_profile'],
    ] as const)(
        'does not let a held scope-A refresh replace the current scope-B durable %s projection during %s transition',
        async (operation, transition) => {
            const sessionId = `held-refresh-${operation}-session`;
            const localId = `held-refresh-${operation}-local`;
            const profileA = upsertServerProfile({ serverUrl: `https://held-${operation}-a.example.test`, name: 'Held A' });
            const profileB = upsertServerProfile({ serverUrl: `https://held-${operation}-b.example.test`, name: 'Held B' });
            const scopeA = { serverId: profileA.id, accountId: `held-${operation}-account-a` } as const;
            const scopeB = { serverId: profileB.id, accountId: `held-${operation}-account-b` } as const;
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

            setActiveServerId(profileA.id, { scope: 'tab' });
            storage.getState().activateProfileScope(scopeA);

            let markRefreshStarted!: () => void;
            const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
            let releaseRefresh!: () => void;
            const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
            const request = async () => {
                markRefreshStarted();
                await refreshGate;
                const rawRecord = {
                    role: 'user' as const,
                    content: { type: 'text' as const, text: 'scope A server row' },
                    meta: {},
                };
                return new Response(JSON.stringify({
                    pending: [{
                        localId,
                        content: { t: 'plain', v: rawRecord },
                        status: 'queued',
                        position: 0,
                        createdAt: 100,
                        updatedAt: 100,
                    }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };

            const encryption = await Encryption.create(new Uint8Array(32).fill(5));
            const heldScopeARefresh = fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption,
                request,
                outboxScope: scopeA,
            });
            await refreshStarted;

            setActiveServerId(profileB.id, { scope: 'tab' });
            if (transition === 'cleared_profile') {
                storage.getState().clearProfileScope();
            }
            (await savePendingOutboxMessage(pendingOutboxFixture({
                sessionId,
                localId,
                text: 'scope B durable row',
                operation,
            }), scopeB));
            expect((await replayPersistedPendingOutboxForSession(sessionId, scopeB))).toEqual([localId]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    text: 'scope B durable row',
                    pendingOutboxScope: scopeB,
                    pendingOutboxOperation: operation,
                }),
            ]);

            releaseRefresh();
            await heldScopeARefresh;

            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    text: 'scope B durable row',
                    pendingOutboxScope: scopeB,
                    pendingOutboxOperation: operation,
                }),
            ]);
            expect((await loadPendingOutboxForSession(sessionId, scopeB))).toEqual([
                expect.objectContaining({ localId, operation }),
            ]);
        },
    );

    it('does not overwrite a durable outbox projection through direct send with the same local id', async () => {
        const sessionId = 'durable-direct-send-collision';
        const localId = 'durable-direct-send-local';
        const outboxScope = storage.getState().profileScope!;
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: { flavor: 'codex', version: '999.0.0' } as Session['metadata'],
        })]);
        (await savePendingOutboxMessage(pendingOutboxFixture({
            sessionId,
            localId,
            text: 'durable owner',
        }), outboxScope));
        (await replayPersistedPendingOutboxForSession(sessionId, outboxScope));

        const { sync } = await import('./sync');
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(4));
        vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as never);

        await expect(sync.sendMessage(
            sessionId,
            'must not overwrite',
            undefined,
            undefined,
            { localId },
        )).rejects.toThrow();

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                text: 'durable owner',
                pendingOutboxScope: outboxScope,
                pendingOutboxOperation: 'enqueue',
            }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toHaveLength(1);
    });

    it('keeps an active runtime RPC ACK timeout as unconfirmed without fallback or retry', async () => {
        const sessionId = 's_active_runtime_rpc_ack_timeout';
        const localId = 'runtime-rpc-timeout-local-id';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC')
            .mockRejectedValue(createSocketIoAckTimeoutError());
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'must-not-fallback',
            seq: 7,
            localId: null,
            didWrite: true,
        })) as any;
        const send = vi.fn();
        sync.setMessageTransport({ emitWithAck, send });

        await expect(sync.sendMessage(
            sessionId,
            'runtime rpc provider custody timeout',
            undefined,
            undefined,
            { localId },
        )).resolves.toEqual({ localId, persistence: 'pending' });

        expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: localId,
                localId,
                deliveryStatus: 'queued',
                sendState: 'unconfirmed',
                text: 'runtime rpc provider custody timeout',
            }),
        ]);
        expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:${localId}`)).toBe(false);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();
    });

    it.each(createFallbackSafeSessionRpcErrors())(
        'persists an active-session runtime RPC fallback in the durable pending queue when %s',
        async (sessionRpcError) => {
            const sessionId = 's_active_runtime_rpc_fallback';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(sessionRpcError);
            const emitWithAck = vi.fn(async () => ({
                ok: true,
                id: 'm-fallback',
                seq: 7,
                localId: null,
                didWrite: true,
            })) as any;
            const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(
                Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
            );

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck,
                send: vi.fn(),
            });

            await expect(sync.sendMessage(
                sessionId,
                'fallback please',
                undefined,
                undefined,
                {
                    localId: 'first-message-local',
                    bypassPendingQueueReason: 'selected_direct',
                },
            )).resolves.toEqual({
                localId: 'first-message-local',
                persistence: 'pending',
            });

            expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(requestSpy).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}/pending`,
                expect.objectContaining({
                    method: 'POST',
                    body: expect.stringContaining('first-message-local'),
                }),
            );
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    id: 'first-message-local',
                    localId: 'first-message-local',
                    deliveryStatus: 'queued',
                    sendState: 'unconfirmed',
                    text: 'fallback please',
                }),
            ]);

            sessionRpcSpy.mockRestore();
            requestSpy.mockRestore();
        },
    );

    it('skips session runtime RPC for older attached CLI versions and uses the legacy socket commit path directly', async () => {
        const sessionId = 's_active_legacy_cli';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: {
                version: '0.0.9',
            } as any,
        })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-legacy',
            seq: 7,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'legacy please');

        expect(sessionRpcSpy).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                localId: expect.any(String),
                messageRole: 'user',
            }),
            expect.anything(),
        );
    });

    it('still uses session runtime RPC for compatible 0.1.0 dev session versions', async () => {
        const sessionId = 's_active_dev_cli';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: {
                version: '0.1.0-dev.1775063171.91734',
            } as any,
        })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-dev',
            seq: 7,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'dev please');

        expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it('forces endpoint auth convergence before a pending retry keeps backing off on timeout', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 's_pending_retry_probe_auth';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const initialSupervisor = createReadyEndpointSupervisor();
            const retrySupervisor = createAuthProbeEndpointSupervisor();
            getEndpointSupervisorForServerMock
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValue(retrySupervisor);

            const emitWithAck = vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('ack timeout'));

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
            sync.setMessageTransport({
                emitWithAck: emitWithAck as any,
                send: vi.fn(),
            });

            await sync.sendMessage(sessionId, 'retry me');
            storage.getState().markSessionOptimisticThinking(sessionId);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(retrySupervisor.invalidate).toHaveBeenCalledTimes(1);
            const retryKeys = Array.from((sync as any).pendingMessageCommitRetryTimers.keys()) as string[];
            expect(retryKeys.some((key) => key.startsWith(`${sessionId}:`))).toBe(false);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('sends plaintext message envelopes when session encryptionMode is plain', async () => {
        const sessionId = 's_plain_send';
        storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

        const encryptRawRecord = vi.fn(async () => {
            throw new Error('encryptRawRecord should not be called')
        })
        const encryption = {
            getSessionEncryption: () => ({ encryptRawRecord }),
        } as unknown as Encryption;

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption as any;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(encryptRawRecord).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                message: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
            expect.anything(),
        );
    });

    it('retries pending message commits with plaintext envelopes for plaintext sessions', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 's_plain_pending_retry';
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

            const getSessionEncryption = vi.fn(() => null);
            const encryption = {
                getSessionEncryption,
            } as unknown as Encryption;

            const emitWithAck = vi.fn()
                .mockImplementationOnce(async () => {
                    throw new Error('ack timeout');
                })
                .mockImplementationOnce(async () => ({
                    ok: true,
                    id: 'm_plain_retry_1',
                    seq: 1,
                    localId: null,
                    didWrite: true,
                })) as any;

            const { sync } = await import('./sync');
            sync.encryption = encryption as any;
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
            sync.setMessageTransport({
                emitWithAck,
                send: vi.fn(),
            });

            await sync.sendMessage(sessionId, 'hello');
            expect(storage.getState().sessionPending[sessionId]?.messages?.length ?? 0).toBe(1);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(getSessionEncryption).not.toHaveBeenCalled();
            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(emitWithAck).toHaveBeenLastCalledWith(
                'message',
                expect.objectContaining({
                    sid: sessionId,
                    message: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                    messageRole: 'user',
                }),
                expect.anything(),
            );
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('includes metaOverrides (e.g. meta.happier) in the outbound rawRecord meta', async () => {
        const sessionId = 's_meta_overrides';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello', 'Review comments (0)', {
            happier: { kind: 'review_comments.v1', payload: { sessionId, comments: [] } },
        } as any);

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(0);
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const transcriptIds = sessionMessages?.messageIdsOldestFirst ?? [];
        const transcript = sessionMessages
            ? transcriptIds.map((id) => sessionMessages.messagesById[id]).filter(Boolean)
            : [];
        const user = transcript.find((m) => m.kind === 'user-text') as any;
        expect(user?.meta?.happier?.kind).toBe('review_comments.v1');
        expect(user?.seq).toBe(1);
    });

    it('does not materialize appendSystemPrompt in first-turn message metadata', async () => {
        const sessionId = 's_profile_override';
        storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = {
            getSessionEncryption: () => null,
        } as any;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(
            sessionId,
            'hello',
            undefined,
            undefined,
            { profileId: 'profile-test' },
        );

        const payload = emitWithAck.mock.calls[0]?.[1];
        expect(payload?.message?.t).toBe('plain');
        expect(Object.prototype.hasOwnProperty.call(payload?.message?.v?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
    });

    it('clears optimistic thinking when a turn is aborted even if session.thinking is already false', async () => {
        const sessionId = 's_turn_aborted';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'turn_aborted',
            id: 'task-abort-1',
            createdAt: Date.now(),
        });

        expect(storage.getState().sessions[sessionId].thinking).toBe(false);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it.each(['turn_failed', 'turn_cancelled'] as const)(
        'clears optimistic thinking when catch-up observes terminal %s lifecycle events',
        async (eventType) => {
            const sessionId = `s_${eventType}`;
            storage.getState().applySessions([createSession({ sessionId })]);
            storage.getState().markSessionOptimisticThinking(sessionId);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

            const { sync } = await import('./sync');
            await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
                type: eventType,
                id: `task-${eventType}`,
                createdAt: Date.now(),
            });

            expect(storage.getState().sessions[sessionId].thinking).toBe(false);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        },
    );

    it('marks running approved tools unavailable when a turn is aborted', async () => {
        const sessionId = 's_turn_aborted_tools';
        const now = Date.now();

        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            agentState: {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 5' },
                        createdAt: now - 5_000,
                        completedAt: now - 4_000,
                        status: 'approved',
                    },
                },
            },
        } as any]);

        storage.getState().applyMessagesLoaded(sessionId);
        storage.getState().applyMessages(sessionId, [{
            id: 'm-tool-call',
            localId: null,
            createdAt: now - 3_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'sleep 5' },
                description: null,
                uuid: 'tool-uuid-1',
                parentUUID: null,
            }],
        } as any]);

        const beforeAbortSessionMessages = storage.getState().sessionMessages[sessionId];
        const beforeAbortIds = beforeAbortSessionMessages?.messageIdsOldestFirst ?? [];
        const beforeAbortMessages = beforeAbortIds.map((id) => beforeAbortSessionMessages.messagesById[id]).filter(Boolean);
        const beforeAbort = beforeAbortMessages.find(
            (message) => message.kind === 'tool-call' && message.tool.permission?.id === 'tool-1'
        );
        if (!beforeAbort || beforeAbort.kind !== 'tool-call') {
            throw new Error('Expected tool-call message before abort');
        }
        expect(beforeAbort.tool.state).toBe('running');

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'turn_aborted',
            id: 'tool-1',
            createdAt: Date.now(),
        });

        const afterAbortSessionMessages = storage.getState().sessionMessages[sessionId];
        const afterAbortIds = afterAbortSessionMessages?.messageIdsOldestFirst ?? [];
        const afterAbortMessages = afterAbortIds.map((id) => afterAbortSessionMessages.messagesById[id]).filter(Boolean);
        const afterAbort = afterAbortMessages.find(
            (message) => message.kind === 'tool-call' && message.tool.permission?.id === 'tool-1'
        );
        if (!afterAbort || afterAbort.kind !== 'tool-call') {
            throw new Error('Expected tool-call message after abort');
        }
        expect(afterAbort.tool.state).toBe('unavailable');
        expect(afterAbort.tool.permission?.status).toBe('approved');
        expect(afterAbort.tool.result).toBeUndefined();
        expect(afterAbort.tool.completedAt).toBeGreaterThanOrEqual(now);
    });

    it.each(['turn_failed', 'turn_cancelled'] as const)(
        'marks running tools unavailable when catch-up observes terminal %s lifecycle events',
        async (eventType) => {
            const sessionId = `s_${eventType}_tools`;
            const now = Date.now();

            storage.getState().applySessions([createSession({ sessionId })]);
            storage.getState().applyMessagesLoaded(sessionId);
            storage.getState().applyMessages(sessionId, [{
                id: `m-tool-call-${eventType}`,
                localId: null,
                createdAt: now - 3_000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: `tool-${eventType}`,
                    name: 'Bash',
                    input: { command: 'sleep 5' },
                    description: null,
                    uuid: `tool-uuid-${eventType}`,
                    parentUUID: null,
                }],
            } as any]);

            const { sync } = await import('./sync');
            await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
                type: eventType,
                id: `tool-${eventType}`,
                createdAt: now,
            });

            const sessionMessages = storage.getState().sessionMessages[sessionId];
            const messages = (sessionMessages?.messageIdsOldestFirst ?? [])
                .map((id) => sessionMessages?.messagesById[id])
                .filter(Boolean);
            const toolMessage = messages.find((message) => message.kind === 'tool-call');
            if (!toolMessage || toolMessage.kind !== 'tool-call') {
                throw new Error(`Expected tool-call message after ${eventType}`);
            }
            expect(toolMessage.tool.state).toBe('unavailable');
            expect(toolMessage.tool.completedAt).toBe(now);
        },
    );

    it('does not force running state from fetched task_started lifecycle events', async () => {
        const sessionId = 's_task_started_fetch';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                latestTurnStatus: 'completed',
            },
        ]);

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_started',
            id: 'task-start-1',
            createdAt: Date.now(),
        });

        expect(storage.getState().sessions[sessionId].thinking).toBe(false);
        expect(storage.getState().sessions[sessionId].latestTurnStatus).toBe('completed');
    });

    it('leaves a newer permission choice pending when an earlier prompt is admitted', async () => {
        const sessionId = 's_perm_next_prompt_frozen';
        storage.getState().applySessions([{
            ...createSession({ sessionId }), encryptionMode: 'plain',
            metadata: { path: '/repo', host: 'host', permissionMode: 'default', permissionModeUpdatedAt: 1 },
        }]);
        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' });
        storage.getState().updateSessionPermissionMode(sessionId, 'yolo');
        const { sync } = await import('./sync');
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        const emitMetadata = vi.spyOn(apiSocket, 'emitWithAck').mockResolvedValue({ result: 'success' });
        sync.setMessageTransport({
            // The transport's generic response is supplied by this JSON boundary fixture.
            emitWithAck: async <T>() => {
                storage.getState().updateSessionPermissionMode(sessionId, 'read-only');
                return { ok: true, id: 'm1', seq: 1, localId: null, didWrite: true } as T;
            },
            send: vi.fn(),
        });
        await sync.sendMessage(sessionId, 'hello');
        expect(emitMetadata.mock.calls.filter(([event]) => event === 'update-metadata')).toHaveLength(0);
        expect(storage.getState().sessions[sessionId].permissionMode).toBe('read-only');
        expect(storage.getState().sessions[sessionId].metadata?.permissionMode).toBe('default');
    });

    it('publishes session metadata after send when apply timing is next_prompt and local permission selection is newer', async () => {
        const sessionId = 's_perm_next_prompt';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }), encryptionMode: 'plain',
                metadata: { path: '/repo', host: 'host', permissionMode: 'default', permissionModeUpdatedAt: 1 },
            },
        ]);

        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' as any });
        storage.getState().updateSessionPermissionMode(sessionId, 'yolo' as any);

        const localUpdatedAt = storage.getState().sessions[sessionId].permissionModeUpdatedAt;
        expect(typeof localUpdatedAt).toBe('number');

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const publish = vi.spyOn(apiSocket, 'emitWithAck').mockImplementation(async <T>(_event: string, data: unknown) => ({
            result: 'success', version: 1, metadata: (data as { metadata: string }).metadata,
        }) as T);

        await sync.sendMessage(sessionId, 'hello');

        const writes = publish.mock.calls.filter(([event]) => event === 'update-metadata');
        expect(writes).toHaveLength(1);
        expect(JSON.parse((writes[0][1] as { metadata: string }).metadata)).toMatchObject({
            permissionMode: 'yolo', permissionModeUpdatedAt: localUpdatedAt,
        });
        expect(storage.getState().sessions[sessionId].metadata?.permissionMode).toBe('yolo');
    });

    it('does not publish an admitted prompt into a different account scope', async () => {
        const sessionId = 's_perm_next_prompt_scope';
        const session = {
            ...createSession({ sessionId }), encryptionMode: 'plain' as const,
            metadata: { path: '/repo', host: 'host', permissionMode: 'default', permissionModeUpdatedAt: 1 },
        } satisfies Session;
        storage.getState().applySessions([session]);
        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' });
        storage.getState().updateSessionPermissionMode(sessionId, 'yolo');
        const { sync } = await import('./sync');
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        const emitMetadata = vi.spyOn(apiSocket, 'emitWithAck').mockResolvedValue({ result: 'success' });
        sync.setMessageTransport({
            // The transport's generic response is supplied by this JSON boundary fixture.
            emitWithAck: async <T>() => {
                storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'other-account' });
                storage.getState().applySessions([session]);
                storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' });
                storage.getState().updateSessionPermissionMode(sessionId, 'yolo');
                return { ok: true, id: 'm1', seq: 1, localId: null, didWrite: true } as T;
            },
            send: vi.fn(),
        });
        await sync.sendMessage(sessionId, 'hello');
        expect(emitMetadata.mock.calls.filter(([event]) => event === 'update-metadata')).toHaveLength(0);
        expect(storage.getState().sessions[sessionId].permissionMode).toBe('yolo');
        expect(storage.getState().sessions[sessionId].metadata?.permissionMode).toBe('default');
    });

    it('returns unpublished when the admitted permission write retires before acknowledgement', async () => {
        const sessionId = 's_perm_next_prompt_retired';
        const session = {
            ...createSession({ sessionId }), encryptionMode: 'plain' as const,
            metadata: { path: '/repo', host: 'host', permissionMode: 'default', permissionModeUpdatedAt: 1 },
        } satisfies Session;
        storage.getState().applySessions([session]);
        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' });
        storage.getState().updateSessionPermissionMode(sessionId, 'yolo');
        const expectedAccountScope = storage.getState().profileScope;
        const { sync } = await import('./sync');
        vi.spyOn(apiSocket, 'emitWithAck').mockImplementation(async <T>(_event: string, data: unknown) => {
            storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'other-account' });
            storage.getState().applySessions([session]);
            storage.getState().updateSessionPermissionMode(sessionId, 'read-only');
            return { result: 'success', version: 1, metadata: (data as { metadata: string }).metadata } as T;
        });
        expect(await sync.publishNextPromptPermissionModeAfterAdmission({
            sessionId, admittedPermissionMode: 'yolo', expectedAccountScope,
        })).toBe(false);
        expect(storage.getState().sessions[sessionId].permissionMode).toBe('read-only');
        expect(storage.getState().sessions[sessionId].metadata?.permissionMode).toBe('default');
    });

    it('does not publish session metadata after send when apply timing is next_prompt but metadata is already up to date', async () => {
        const sessionId = 's_perm_next_prompt_noop';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }), encryptionMode: 'plain',
                metadata: { path: '/repo', host: 'host', permissionMode: 'safe-yolo', permissionModeUpdatedAt: Date.now() },
            },
        ]);

        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' as any });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const publish = vi.spyOn(apiSocket, 'emitWithAck').mockResolvedValue({ result: 'success' });

        await sync.sendMessage(sessionId, 'hello');

        expect(publish.mock.calls.filter(([event]) => event === 'update-metadata')).toHaveLength(0);
    });
});
