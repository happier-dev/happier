import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { buildSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursor';
import {
    publishSessionNavigationCursor,
    resetSessionNavigationCursorForTests,
} from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import type { SessionListLikeItem } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerNavigateSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({
    pathname: '/session/s1',
    params: {} as Record<string, string | undefined>,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => routeState.pathname,
        params: () => routeState.params,
        router: {
            navigate: routerNavigateSpy,
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: async () => {} }),
    getCurrentAuth: () => ({ refreshFromActiveServer: async () => {} }),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: vi.fn(async () => true),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => '',
}));

function sessionItem(sessionId: string): SessionListLikeItem {
    return { type: 'session', serverId: 'server_a', session: { id: sessionId } };
}

function publishCursor(sessionIds: readonly string[]): void {
    const cursor = buildSessionNavigationCursor({
        identity: { origin: 'session-list', sourceScopeKey: 'scope-a', storageKind: 'all' },
        items: sessionIds.map(sessionItem),
        nowMs: 1_000,
    });
    if (!cursor) throw new Error('expected a navigable cursor fixture');
    publishSessionNavigationCursor(cursor);
}

async function renderNeighborNavigation() {
    const { useSessionNeighborNavigation } = await import('./useSessionNeighborNavigation');
    return renderHook(() => useSessionNeighborNavigation());
}

describe('useSessionNeighborNavigation', () => {
    beforeEach(() => {
        standardCleanup();
        resetSessionNavigationCursorForTests();
        routerNavigateSpy.mockClear();
        routerPushSpy.mockClear();
        routeState.pathname = '/session/s1';
        routeState.params = { serverId: 'server_a' };
        storage.setState((state) => ({ ...state, sessions: {}, deletedSessionIds: {} }));
    });

    it('steps to the neighbour through the singular session navigate', async () => {
        publishCursor(['s1', 's2', 's3']);
        const hook = await renderNeighborNavigation();

        let result: ReturnType<ReturnType<typeof hook.getCurrent>['step']> | null = null;
        await act(async () => {
            result = hook.getCurrent().step('next');
        });

        expect(result).toEqual({ kind: 'target', entry: expect.objectContaining({ sessionId: 's2' }) });
        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s2?serverId=server_a', expect.any(Object));
        expect(routerNavigateSpy.mock.calls[0]?.[1]?.dangerouslySingular?.()).toBe('session');
    });

    it('moves two entries across two steps while the route still lags behind', async () => {
        publishCursor(['s1', 's2', 's3']);
        const hook = await renderNeighborNavigation();

        await act(async () => {
            hook.getCurrent().step('next');
        });
        await act(async () => {
            hook.getCurrent().step('next');
        });

        expect(routerNavigateSpy.mock.calls.map((call) => call[0])).toEqual([
            '/session/s2?serverId=server_a',
            '/session/s3?serverId=server_a',
        ]);
    });

    it('reports an edge at the end of the captured order without navigating', async () => {
        publishCursor(['s1', 's2', 's3']);
        routeState.pathname = '/session/s3';
        const hook = await renderNeighborNavigation();

        let result: unknown = null;
        await act(async () => {
            result = hook.getCurrent().step('next');
        });

        expect(result).toEqual({ kind: 'edge' });
        expect(routerNavigateSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().nextEntry).toBeNull();
        expect(hook.getCurrent().previousEntry).toEqual(expect.objectContaining({ sessionId: 's2' }));
    });

    it('reports unavailable when no cursor has been published', async () => {
        const hook = await renderNeighborNavigation();

        let result: unknown = null;
        await act(async () => {
            result = hook.getCurrent().step('next');
        });

        expect(result).toEqual({ kind: 'unavailable' });
        expect(routerNavigateSpy).not.toHaveBeenCalled();
    });

    it('skips an entry that is no longer navigable', async () => {
        publishCursor(['s1', 's2', 's3']);
        storage.setState((state) => ({
            ...state,
            sessions: {
                s2: createSessionFixture({ id: 's2', archivedAt: 5 }),
            },
        }));
        const hook = await renderNeighborNavigation();

        await act(async () => {
            hook.getCurrent().step('next');
        });

        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s3?serverId=server_a', expect.any(Object));
    });
});
