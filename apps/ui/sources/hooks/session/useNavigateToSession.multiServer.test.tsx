import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerNavigateSpy = vi.fn();
const setActiveServerSpy = vi.fn();

let activeServerId = 'active';

vi.mock('expo-router', () => ({
    useRouter: () => ({
        navigate: routerNavigateSpy,
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: activeServerId,
        serverUrl: 'http://example.test',
        kind: 'stack',
        generation: 1,
    }),
    setActiveServer: setActiveServerSpy,
}));

describe('useNavigateToSession (multi-server)', () => {
    it('switches active server when passed a different serverId', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerSpy.mockClear();
        activeServerId = 'active';

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        await act(async () => {
            navigateToSession!('sess_123', { serverId: 'other' });
        });

        expect(setActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(setActiveServerSpy).toHaveBeenCalledWith({ serverId: 'other', scope: 'device' });
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_123', expect.any(Object));
    });

    it('does not switch active server when the serverId matches', async () => {
        routerNavigateSpy.mockClear();
        setActiveServerSpy.mockClear();
        activeServerId = 'same';

        const { useNavigateToSession } = await import('./useNavigateToSession');

        let navigateToSession: ReturnType<typeof useNavigateToSession> | null = null;
        function Probe() {
            navigateToSession = useNavigateToSession();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        await act(async () => {
            navigateToSession!('sess_456', { serverId: 'same' });
        });

        expect(setActiveServerSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
    });
});

