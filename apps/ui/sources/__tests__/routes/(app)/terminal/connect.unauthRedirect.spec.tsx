import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installTerminalRouteCommonModuleMocks } from './terminalRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
const setPendingMock = vi.fn((_pending: { publicKeyB64Url: string; serverUrl: string }) => {});
const upsertActivateAndSwitchServerMock = vi.fn(async (_params: { serverUrl: string; source: string; scope: string; refreshAuth?: unknown }) => true);

installTerminalRouteCommonModuleMocks({
    router: async () =>
        createExpoRouterMock({
            router: { back: vi.fn(), replace: replaceMock, push: vi.fn(), setParams: vi.fn() },
            pathname: '/terminal/connect',
        }).module,
});

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ processAuthUrl: vi.fn(async () => {}), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false, credentials: null }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: setPendingMock,
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerMock,
}));

describe('TerminalConnectScreen unauthenticated redirect', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.unmock('@/utils/path/terminalConnectUrl');
        replaceMock.mockClear();
        setPendingMock.mockClear();
        upsertActivateAndSwitchServerMock.mockClear();
        (globalThis as any).window = {
            location: {
                hash: '#key=abc123&server=https%3A%2F%2Fcompany.example.test',
                pathname: '/terminal/connect',
                search: '',
                href: 'https://ui.example.test/terminal/connect#key=abc123&server=https%3A%2F%2Fcompany.example.test',
            },
            history: { replaceState: vi.fn() },
        };
    });

    it('stores pending connect and redirects to auth screen immediately', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(setPendingMock).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://company.example.test',
        });
        expect(upsertActivateAndSwitchServerMock).toHaveBeenCalledWith({
            serverUrl: 'https://company.example.test',
            source: 'url',
            scope: 'device',
            refreshAuth: undefined,
        });
        expect(replaceMock).toHaveBeenCalledWith('/');
    });
});
