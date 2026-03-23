import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTerminalRouteCommonModuleMocks } from './terminalRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearPendingMock = vi.fn();

installTerminalRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: vi.fn(), replace: vi.fn() },
            params: { key: 'abc123', server: 'https://example.test' },
        }).module;
    },
});

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ processAuthUrl: vi.fn(async () => {}), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: (...args: any[]) => clearPendingMock(...args),
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://api.happier.dev',
}));

afterEach(() => {
    standardCleanup();
});

describe('TerminalScreen authenticated buttons', () => {
    beforeEach(() => {
        vi.resetModules();
        clearPendingMock.mockClear();
    });

    it('exposes stable testIDs for approve/reject buttons on /terminal', async () => {
        const Screen = (await import('@/app/(app)/terminal/index')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        const buttonTestIds = screen
            .findAllByType('RoundButton')
            .map((node) => node.props?.testID)
            .filter(Boolean);

        expect(buttonTestIds).toContain('terminal-connect-approve');
        expect(buttonTestIds).toContain('terminal-connect-reject');
    });
});
