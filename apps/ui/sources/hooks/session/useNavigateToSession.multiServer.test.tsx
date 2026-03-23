import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerNavigateSpy = vi.fn();
const setActiveServerAndSwitchSpy = vi.fn(async () => false);
const refreshFromActiveServerSpy = vi.fn(async () => {});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: {
        navigate: routerNavigateSpy,
    },
    });
    return expoRouterMock.module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: setActiveServerAndSwitchSpy,
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
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_123', expect.any(Object));
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
    });
});
