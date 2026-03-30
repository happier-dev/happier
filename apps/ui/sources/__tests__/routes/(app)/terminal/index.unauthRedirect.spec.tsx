import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installTerminalRouteCommonModuleMocks, resetTerminalRouteTestState } from './terminalRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
const setPendingMock = vi.fn();
let searchParamsServerValue: string | undefined = 'https://example.test';
const routerMock = createTerminalRouterMock();

installTerminalRouteCommonModuleMocks({
    router: () => routerMock.module,
});

function createTerminalRouterMock() {
    return createExpoRouterMock({
        router: { back: vi.fn(), replace: replaceMock },
        params: () => ({ key: 'abc123', server: searchParamsServerValue }),
    });
}

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ processAuthUrl: vi.fn(async () => {}), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false, credentials: null }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: (...args: any[]) => setPendingMock(...args),
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://api.happier.dev',
}));

describe('TerminalScreen unauthenticated redirect', () => {
    afterEach(() => {
        standardCleanup();
        resetTerminalRouteTestState();
    });

    beforeEach(() => {
        vi.resetModules();
        replaceMock.mockClear();
        setPendingMock.mockClear();
        searchParamsServerValue = 'https://example.test';
    });

    it('stores pending connect and redirects to auth screen immediately', async () => {
        const Screen = (await import('@/app/(app)/terminal/index')).default;
        routerMock.state.params = { key: 'abc123', server: searchParamsServerValue };

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(setPendingMock).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://example.test',
        });
        expect(replaceMock).toHaveBeenCalledWith('/');
    });

    it('ignores loopback server overrides and keeps the active server when redirecting', async () => {
        searchParamsServerValue = 'http://localhost:53288';

        const Screen = (await import('@/app/(app)/terminal/index')).default;
        routerMock.state.params = { key: 'abc123', server: searchParamsServerValue };

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(setPendingMock).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://api.happier.dev',
        });
        expect(replaceMock).toHaveBeenCalledWith('/');
    });
});
