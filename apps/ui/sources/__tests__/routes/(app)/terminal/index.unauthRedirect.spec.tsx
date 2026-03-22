import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
const setPendingMock = vi.fn();
let searchParamsServerValue: string | undefined = 'https://example.test';
const routerMock = createTerminalRouterMock();

function createTerminalRouterMock() {
    return createExpoRouterMock({
        router: { back: vi.fn(), replace: replaceMock },
        params: () => ({ key: 'abc123', server: searchParamsServerValue }),
    });
}

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    return routerMock.module;
});

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: 'View',
                                    Platform: {
                                        OS: 'web',
                                        select: (options: Record<string, unknown>) => options.web ?? options.default ?? options.ios ?? options.android,
                                    },
                                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { textDestructive: '#f00', textSecondary: '#666', radio: { active: '#0af' }, text: '#000', success: '#0a0' } },
    });
});

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

describe('TerminalScreen unauthenticated redirect', () => {
    afterEach(() => {
        standardCleanup();
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
