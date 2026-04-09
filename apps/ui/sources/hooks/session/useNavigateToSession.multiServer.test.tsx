import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionHooksCommonModuleMocks } from './sessionHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerNavigateSpy = vi.fn();
const setActiveServerAndSwitchSpy = vi.fn(async () => false);
const refreshFromActiveServerSpy = vi.fn(async () => {});
const resolveSessionTargetServerIdSpy = vi.fn<(sessionId: string, fallbackServerId?: string | null) => string | null>();
const preferredServerIdState = vi.hoisted(() => ({
    current: 'preferred-server' as string | null,
}));

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

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
    resolveSessionTargetServerId: (...args: unknown[]) => resolveSessionTargetServerIdSpy(args[0] as string, args[1] as string | null | undefined),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => preferredServerIdState.current,
}));

describe('useNavigateToSession (multi-server)', () => {
    it('navigates immediately while the server switch runs in parallel', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockReturnValue('other');
        let resolveSwitch: ((value: boolean) => void) | undefined;
        const switchPromise = new Promise<boolean>((resolve) => {
            resolveSwitch = resolve;
        });
        setActiveServerAndSwitchSpy.mockImplementation(() => switchPromise);

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let navigationPromise: Promise<void> | null = null;
        await act(async () => {
            navigationPromise = navigateToSession!('sess_123', { serverId: 'other' });
        });

        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledTimes(1);
        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'other',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_123', expect.any(Object));
        expect(routerNavigateSpy.mock.calls[0]?.[1]?.dangerouslySingular?.()).toBe('session');

        if (!resolveSwitch) {
            throw new Error('Expected server switch resolver to be initialized');
        }
        resolveSwitch(true);
        await act(async () => {
            await navigationPromise;
        });
    });

    it('requests switch orchestration when serverId is provided', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        setActiveServerAndSwitchSpy.mockResolvedValue(false);
        resolveSessionTargetServerIdSpy.mockReturnValue('same');

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
    });

    it('falls back to the canonical preferred server id when serverId is omitted', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockClear();
        preferredServerIdState.current = 'preferred-server';
        resolveSessionTargetServerIdSpy.mockImplementation(() => {
            throw new Error('legacy wrapper should not be used in useNavigateToSession');
        });

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

        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'preferred-server',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_789', expect.any(Object));
    });

    it('recomputes the preferred server id after rerender before navigating', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockClear();
        preferredServerIdState.current = 'preferred-server';
        resolveSessionTargetServerIdSpy.mockImplementation(() => {
            throw new Error('legacy wrapper should not be used in useNavigateToSession');
        });

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        const screen = await renderScreen(React.createElement(Probe));

        await act(async () => {
            await navigateToSession!('sess_999');
        });

        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'preferred-server',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_999', expect.any(Object));

        preferredServerIdState.current = 'preferred-updated';
        await act(async () => {
            await screen.update(React.createElement(Probe));
        });
        await act(async () => {
            await navigateToSession!('sess_999');
        });

        expect(setActiveServerAndSwitchSpy).toHaveBeenLastCalledWith({
            serverId: 'preferred-updated',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(routerNavigateSpy).toHaveBeenLastCalledWith('/session/sess_999', expect.any(Object));
    });

    it('normalizes whitespace around the session id before resolving and navigating', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockClear();
        preferredServerIdState.current = 'preferred-server';
        resolveSessionTargetServerIdSpy.mockImplementation(() => {
            throw new Error('legacy wrapper should not be used in useNavigateToSession');
        });

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await navigateToSession!('  sess_whitespace  ');
        });

        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_whitespace', expect.any(Object));
    });
});
