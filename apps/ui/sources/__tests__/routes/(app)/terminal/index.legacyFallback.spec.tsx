import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackMock = vi.fn();
const localSearchParamsMock = vi.fn((): Record<string, string> => ({ server: 'https://example.test' }));
const routerMock = createTerminalRouterMock();

function createTerminalRouterMock() {
    return createExpoRouterMock({
        router: { back: routerBackMock },
        params: () => localSearchParamsMock(),
    });
}

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    return routerMock.module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ processAuthUrl: vi.fn(async () => {}), isLoading: false }),
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
        theme: { colors: { textDestructive: '#f00', textSecondary: '#666', radio: { active: '#0af' }, text: '#000' } },
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
    Item: 'Item',
}));

describe('TerminalScreen legacy deep-link fallback', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        vi.resetModules();
        routerBackMock.mockClear();
        localSearchParamsMock.mockReset();
        localSearchParamsMock.mockReturnValue({ server: 'https://example.test' });
    });

    it('does not treat known params like server as a legacy public key', async () => {
        const Screen = (await import('@/app/(app)/terminal/index')).default;
        routerMock.state.params = localSearchParamsMock();

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLink');
    });

    it('uses legacy fallback when exactly one unknown search param key is present', async () => {
        localSearchParamsMock.mockReturnValue({ abcdefghijklmnop: '' });
        const Screen = (await import('@/app/(app)/terminal/index')).default;
        routerMock.state.params = localSearchParamsMock();

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        const renderedItems = screen.root.findAll((node) => (node.type as unknown) === 'Item');
        const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
        expect(publicKeyItem).toBeTruthy();
        expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
    });
});
