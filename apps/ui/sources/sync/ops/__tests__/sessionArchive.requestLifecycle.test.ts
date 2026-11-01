import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionFixture } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { archiveSessionWithPendingState, isSessionArchivePending, stopSessionAndMaybeArchive } from '@/components/sessions/sessionStopArchiveFlow';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { peekServerReachabilityState, resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { stopAllEndpointSupervisorsForTests } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { sessionArchiveWithServerScope } from '../sessions';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { Encryption } from '@/sync/encryption/encryption';
import { getServerFetchUrl } from '@/dev/testkit/mocks/serverFetch';

// The native Socket.IO transport is external; keep ApiSocket's configuration and HTTP path real.
vi.mock('socket.io-client', async () => {
    const { createSocketHarness } = await import('@/dev/testkit/harness/socketHarness');
    return {
        io: () => {
            const events = createSocketHarness<Record<string, unknown>>();
            const socket = {
                connected: false,
                connect() { socket.connected = true; events.emit('connect', undefined); return socket; },
                disconnect() { socket.connected = false; events.emit('disconnect', 'io client disconnect'); return socket; },
                on: events.on,
                off: events.off,
                emit: events.emit,
                onAny() {}, offAny() {}, removeAllListeners() {},
            };
            return socket;
        },
    };
});

describe('archive request recovery', () => {
    const sessionId = 'archive_request_lifecycle';
    let targetServerId: string;
    let targetServerUrl: string;
    let activeServer: ReturnType<typeof upsertServerProfile>;

    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
        const active = upsertServerProfile({ serverUrl: 'https://archive-request-active.example' });
        activeServer = active;
        const remote = upsertServerProfile({ serverUrl: 'https://archive-request-remote.example' });
        setActiveServerId(active.id);
        targetServerId = remote.id;
        targetServerUrl = remote.serverUrl;
        storage.getState().applySessions([createSessionFixture({ id: sessionId, archivedAt: null })]);
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ.signature',
        });
    });

    afterEach(async () => {
        apiSocket.disconnect();
        await resetServerReachabilitySupervisors();
        await stopAllEndpointSupervisorsForTests();
        resetRuntimeFetch();
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS;
    });

    it.each([
        { stalledPhase: 'headers', afterStop: true, budget: '1000', target: 'remote' },
        { stalledPhase: 'body', afterStop: true, budget: '1000', target: 'remote' },
        { stalledPhase: 'headers', afterStop: false, budget: '1000', target: 'remote' },
        { stalledPhase: 'body', afterStop: false, budget: '1000', target: 'remote' },
        { stalledPhase: 'body', afterStop: true, budget: '0', target: 'remote' },
        { stalledPhase: 'body', afterStop: true, budget: '1000', target: 'active' },
    ] as const)('aborts a stalled $target archive $stalledPhase (afterStop=$afterStop, budget=$budget), releases admission, and admits a successful retry', async ({ stalledPhase, afterStop, budget, target }) => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS = budget;
        const requested = createDeferred<void>();
        const network: { signal?: AbortSignal | null } = {};
        let attempts = 0;
        const cleanup = createDeferred<void>();
        setRuntimeFetch(async (input, init) => {
            if (!getServerFetchUrl(input).pathname.endsWith('/archive')) return new Response('ok');
            attempts += 1;
            if (attempts > 1) return new Response(JSON.stringify({ success: true, archivedAt: 42 }));
            network.signal = init?.signal ?? null;
            requested.resolve();
            if (stalledPhase === 'headers') {
                return await new Promise<Response>((resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    void cleanup.promise.then(() => resolve(new Response('{}')));
                });
            }
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
                    void cleanup.promise.then(() => { if (!init?.signal?.aborted) controller.close(); });
                },
            }), { headers: { 'content-type': 'application/json' } });
        });
        if (target === 'active') {
            targetServerId = activeServer.id;
            targetServerUrl = activeServer.serverUrl;
            apiSocket.initialize({ endpoint: activeServer.serverUrl, token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' },
                Encryption.createWithoutKeyMaterial());
        }
        vi.useFakeTimers();
        const result = afterStop ? stopSessionAndMaybeArchive({
            sessionId, serverId: targetServerId, hideInactiveSessions: true, isPinned: false, archiveAfterStop: 'always',
            stopSession: async () => ({ success: true }),
            archiveSession: (options) => sessionArchiveWithServerScope(sessionId, { serverId: targetServerId, ...options }),
            stopErrorMessage: 'stop failed', archiveErrorMessage: 'archive failed',
        }) : archiveSessionWithPendingState(sessionId,
            () => sessionArchiveWithServerScope(sessionId, { serverId: targetServerId }), targetServerId);
        let settled = false;
        const outcome = result.then((value) => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(attempts).toBe(1));
            await requested.promise;
            expect(isSessionArchivePending(sessionId, targetServerId)).toBe(true);
            await vi.advanceTimersByTimeAsync(Number(budget) || 75_000);
            expect({ settled, aborted: network.signal?.aborted, pending: isSessionArchivePending(sessionId, targetServerId) })
                .toEqual({ settled: true, aborted: true, pending: false });
            if (afterStop) {
                expect(await outcome).toMatchObject({ error: { message: 'archive failed' } });
            } else {
                expect(await outcome).toEqual({ value: { success: false, code: 'session_archive_timeout' } });
            }
            expect(peekServerReachabilityState(targetServerUrl)?.phase).toBe('online');
            expect(storage.getState().sessions[sessionId]?.archivedAt).toBeNull();
            await expect(archiveSessionWithPendingState(sessionId,
                () => sessionArchiveWithServerScope(sessionId, { serverId: targetServerId }), targetServerId))
                .resolves.toMatchObject({ success: true, archivedAt: 42 });
            expect(attempts).toBe(2);
        } finally {
            cleanup.resolve();
            await outcome;
        }
    });

    it('shares one deadline across the first response body and later inactivity retries', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS = '1000';
        const firstRequested = createDeferred<void>();
        const firstResponse = createDeferred<Response>();
        const secondResponse = createDeferred<Response>();
        let attempts = 0;
        const network: { signal?: AbortSignal | null } = {};
        setRuntimeFetch(async (input, init) => {
            if (!getServerFetchUrl(input).pathname.endsWith('/archive')) return new Response('ok');
            attempts += 1;
            if (attempts === 1) {
                firstRequested.resolve();
                return await firstResponse.promise;
            }
            network.signal = init?.signal ?? null;
            return await new Promise<Response>((resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                void secondResponse.promise.then(resolve);
            });
        });
        vi.useFakeTimers();
        let settled = false;
        const result = stopSessionAndMaybeArchive({
            sessionId, serverId: targetServerId, hideInactiveSessions: true, isPinned: false, archiveAfterStop: 'always',
            stopSession: async () => ({ success: true }),
            archiveSession: (options) => sessionArchiveWithServerScope(sessionId, { serverId: targetServerId, ...options }),
            stopErrorMessage: 'stop failed', archiveErrorMessage: 'archive failed',
        }).catch((error: unknown) => error).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(attempts).toBe(1));
            await firstRequested.promise;
            await vi.advanceTimersByTimeAsync(600);
            firstResponse.resolve(new Response(JSON.stringify({ error: 'session-active' }), { status: 409 }));
            await vi.advanceTimersByTimeAsync(200);
            expect(attempts).toBe(2);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(200);
            expect({ settled, aborted: network.signal?.aborted, pending: isSessionArchivePending(sessionId, targetServerId) })
                .toEqual({ settled: true, aborted: true, pending: false });
            expect(await result).toBeInstanceOf(Error);
        } finally {
            firstResponse.resolve(new Response('{}'));
            secondResponse.resolve(new Response(JSON.stringify({ success: true, archivedAt: 42 })));
            await result;
        }
    });
});
