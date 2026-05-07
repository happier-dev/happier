import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionHooksCommonModuleMocks } from './sessionHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerNavigateSpy = vi.fn();
const setActiveServerAndSwitchSpy = vi.fn(async () => false);
const refreshFromActiveServerSpy = vi.fn(async () => {});
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.fn();

installSessionHooksCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: {
                navigate: routerNavigateSpy,
            },
        });
        return expoRouterMock.module;
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: setActiveServerAndSwitchSpy,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
}));

describe('useNavigateToSession (multi-server)', () => {
    it('switches active server when passed a different serverId', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        setActiveServerAndSwitchSpy.mockResolvedValue(true);

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await navigateToSession!('sess_123', { serverId: 'other' });
        });

        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledTimes(1);
        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'other',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_123?serverId=other', expect.any(Object));
        expect(routerNavigateSpy.mock.calls[0]?.[1]?.dangerouslySingular?.()).toBe('session');
    });

    it('navigates before active server switching settles', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        let resolveSwitch: () => void = () => {};
        const switchPromise = new Promise<boolean>((resolve) => {
            resolveSwitch = () => resolve(true);
        });
        setActiveServerAndSwitchSpy.mockReturnValueOnce(switchPromise);

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let navigationPromise: Promise<void> | null = null;
        act(() => {
            navigationPromise = navigateToSession!('sess_pending', { serverId: 'server-pending' });
        });

        try {
            expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
                serverId: 'server-pending',
                scope: 'device',
                refreshAuth: expect.any(Function),
            });
            expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_pending?serverId=server-pending', expect.any(Object));
        } finally {
            resolveSwitch();
            await act(async () => {
                await navigationPromise;
            });
        }
    });

    it('requests switch orchestration when serverId is provided', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        setActiveServerAndSwitchSpy.mockResolvedValue(false);

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await navigateToSession!('sess_456', { serverId: 'same' });
        });

        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'same',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_456?serverId=same', expect.any(Object));
    });

    it('falls back to the cached owning serverId when no explicit serverId is provided', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReset();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cached');

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await navigateToSession!('sess_789');
        });

        expect(resolveServerIdForSessionIdFromLocalCacheSpy).toHaveBeenCalledWith('sess_789');
        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'server-cached',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_789?serverId=server-cached', expect.any(Object));
    });
});
