import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { useHydrateSessionForRoute } from './useHydrateSessionForRoute';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';

type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

(globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

async function storeSession(overrides: Parameters<typeof createSessionFixture>[0] = {}): Promise<void> {
    await act(async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                [overrides.id ?? 'session-1']: createSessionFixture(overrides),
            },
        }));
    });
}

const ensureSessionVisibleForMessageRouteSpy = vi.hoisted(() =>
    vi.fn<(sessionId: string, options?: Readonly<{ serverId?: string; forceRefresh?: boolean }>) => Promise<unknown>>(),
);
const getSessionEncryptionSpy = vi.hoisted(() => vi.fn<(sessionId: string) => unknown>());
const activeServerSnapshotMock = vi.hoisted(() => ({
    current: {
        serverId: '',
        serverUrl: '',
        activeShareableServerUrl: null,
        activeLocalRelayUrl: null,
        generation: 0,
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock.current,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string, options?: Readonly<{ serverId?: string; forceRefresh?: boolean }>) =>
            ensureSessionVisibleForMessageRouteSpy(sessionId, options),
        encryption: {
            getSessionEncryption: (sessionId: string) => getSessionEncryptionSpy(sessionId),
        },
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => {
        void promise.catch(() => {});
    },
}));

describe('useHydrateSessionForRoute', () => {
    let previousStorageState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousStorageState = storage.getState();
        ensureSessionVisibleForMessageRouteSpy.mockReset();
        getSessionEncryptionSpy.mockReset();
        activeServerSnapshotMock.current = {
            serverId: '',
            serverUrl: '',
            activeShareableServerUrl: null,
            activeLocalRelayUrl: null,
            generation: 0,
        };
    });

    afterEach(async () => {
        standardCleanup();
        await act(async () => {
            storage.setState(previousStorageState, true);
        });
    });

    it('marks the route ready after hydration succeeds', async () => {
        const deferred = createDeferred<unknown>();
        ensureSessionVisibleForMessageRouteSpy.mockReturnValueOnce(deferred.promise);

        const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

        expect(hook.getCurrent()).toMatchObject({
            kind: 'loading',
            sessionId: 'session-1',
        });

        await storeSession({
            id: 'session-1',
            agentState: { controlledByUser: true },
            encryptionMode: 'plain',
        });
        deferred.resolve({ kind: 'available', sessionId: 'session-1' });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
        });
    });

    it('retries hydration after a failure and eventually succeeds', async () => {
        const deferred1 = createDeferred<unknown>();
        const deferred2 = createDeferred<unknown>();
        ensureSessionVisibleForMessageRouteSpy
            .mockReturnValueOnce(deferred1.promise)
            .mockReturnValueOnce(deferred2.promise);
        const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

        expect(hook.getCurrent()).toMatchObject({
            kind: 'loading',
            sessionId: 'session-1',
        });

        await act(async () => {
            deferred1.reject(new Error('hydrate failed'));
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            kind: 'retrying',
            sessionId: 'session-1',
            cause: 'unknown',
        });

        await vi.waitFor(() => {
            expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(2);
        }, { timeout: 3_000 });

        await storeSession({
            id: 'session-1',
            agentState: { controlledByUser: true },
            encryptionMode: 'plain',
        });
        deferred2.resolve({ kind: 'available', sessionId: 'session-1' });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
        });
        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(2);
    });

    it('stops retrying when component unmounts', async () => {
        const deferred = createDeferred<unknown>();
        ensureSessionVisibleForMessageRouteSpy.mockReturnValue(deferred.promise);

        const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

        expect(hook.getCurrent()).toMatchObject({
            kind: 'loading',
            sessionId: 'session-1',
        });

        await act(async () => {
            deferred.reject(new Error('hydrate failed'));
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await hook.unmount();

        await new Promise((resolve) => setTimeout(resolve, 2_200));

        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(1);
    });

    it('is ready immediately and skips hydration when the session is already authoritatively hydrated', async () => {
        await storeSession({
            id: 'session-1',
            agentState: { controlledByUser: true },
            encryptionMode: 'e2ee',
        });
        getSessionEncryptionSpy.mockReturnValue({ decryptMetadata: vi.fn() });

        const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
        });
        expect(ensureSessionVisibleForMessageRouteSpy).not.toHaveBeenCalled();
    });

    it('keeps cached available route hydration state referentially stable across parent rerenders', async () => {
        await storeSession({
            id: 'session-1',
            agentState: { controlledByUser: true },
            encryptionMode: 'e2ee',
        });
        getSessionEncryptionSpy.mockReturnValue({ decryptMetadata: vi.fn() });

        const hook = await renderHook(
            (_props: { parentVersion: number }) => useHydrateSessionForRoute('session-1', 'route.hydrate'),
            { initialProps: { parentVersion: 1 } },
        );
        const initialState = hook.getCurrent();

        await hook.rerender({ parentVersion: 2 });

        expect(hook.getCurrent()).toBe(initialState);
        expect(ensureSessionVisibleForMessageRouteSpy).not.toHaveBeenCalled();
    });

    it('treats hydrated encrypted sessions with null agent state as available', async () => {
        ensureSessionVisibleForMessageRouteSpy.mockResolvedValueOnce({
            kind: 'retryable_failure',
            sessionId: 'session-1',
            cause: 'unknown',
        });
        await storeSession({
            id: 'session-1',
            agentState: null,
            encryptionMode: 'e2ee',
        });
        getSessionEncryptionSpy.mockReturnValue({ decryptMetadata: vi.fn() });

        const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
        });
        expect(ensureSessionVisibleForMessageRouteSpy).not.toHaveBeenCalled();
    });

    it('passes an explicit serverId override through to hydration', async () => {
        ensureSessionVisibleForMessageRouteSpy.mockResolvedValueOnce({
            kind: 'available',
            sessionId: 'session-1',
            serverId: 'server-b',
        });

        const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate', { serverId: 'server-b' }));

        await storeSession({
            id: 'session-1',
            agentState: { controlledByUser: true },
            encryptionMode: 'plain',
            serverId: 'server-b',
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
            serverId: 'server-b',
        });
        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
    });

    it('marks terminal missing results without retrying forever', async () => {
        ensureSessionVisibleForMessageRouteSpy.mockResolvedValueOnce({
            kind: 'missing',
            sessionId: 'session-1',
            cause: 'not_found',
        });

        const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            kind: 'missing',
            sessionId: 'session-1',
            cause: 'not_found',
        });
        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps an already hydrated active-server session available for an unknown route server alias', async () => {
        activeServerSnapshotMock.current = {
            serverId: 'server-actual',
            serverUrl: 'http://localhost',
            activeShareableServerUrl: null,
            activeLocalRelayUrl: null,
            generation: 0,
        };
        await storeSession({
            id: 'session-1',
            serverId: 'server-actual',
            agentState: { controlledByUser: true },
            encryptionMode: 'plain',
        });

        const hook = await renderHook(() =>
            useHydrateSessionForRoute('session-1', 'route.hydrate', { serverId: 'stale-route-server' }),
        );

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
            serverId: 'server-actual',
        });
        expect(ensureSessionVisibleForMessageRouteSpy).not.toHaveBeenCalled();
    });

    it('accepts the hydrated server id when an unknown route server alias falls back to the active server', async () => {
        const deferred = createDeferred<unknown>();
        ensureSessionVisibleForMessageRouteSpy.mockReturnValueOnce(deferred.promise);

        const hook = await renderHook(() =>
            useHydrateSessionForRoute('session-1', 'route.hydrate', { serverId: 'stale-route-server' }),
        );

        await storeSession({
            id: 'session-1',
            serverId: 'server-actual',
            agentState: { controlledByUser: true },
            encryptionMode: 'plain',
        });
        deferred.resolve({ kind: 'available', sessionId: 'session-1', serverId: 'server-actual' });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
            serverId: 'server-actual',
        });
    });

    it('moves an available route to missing after an authoritative forbidden refresh', async () => {
        await storeSession({
            id: 'session-1',
            serverId: 'server-a',
            agentState: { controlledByUser: true },
            encryptionMode: 'e2ee',
        });
        getSessionEncryptionSpy.mockReturnValue({ decryptMetadata: vi.fn() });
        ensureSessionVisibleForMessageRouteSpy.mockResolvedValueOnce({
            kind: 'missing',
            sessionId: 'session-1',
            serverId: 'server-a',
            cause: 'forbidden',
        });

        const hook = await renderHook(
            (props: { forceRefresh: boolean }) =>
                useHydrateSessionForRoute('session-1', 'route.hydrate', { serverId: 'server-a', forceRefresh: props.forceRefresh }),
            { initialProps: { forceRefresh: false } },
        );

        expect(hook.getCurrent()).toMatchObject({
            kind: 'available',
            sessionId: 'session-1',
            serverId: 'server-a',
        });

        await hook.rerender({ forceRefresh: true });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            kind: 'missing',
            sessionId: 'session-1',
            serverId: 'server-a',
            cause: 'forbidden',
        });
    });

});
