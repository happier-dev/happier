import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackMock = vi.fn();
const getPendingTerminalConnectMock = vi.fn<() => PendingTerminalConnect | null>(() => null);
const globalWindow = globalThis as unknown as { window?: Window };
const originalWindow = globalWindow.window;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { back: routerBackMock },
    });
    return routerMock.module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: getPendingTerminalConnectMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: vi.fn(async () => true),
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
                                        select: (options: Record<string, unknown>) => options.web ?? options.default,
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

describe('TerminalConnectScreen hash parsing', () => {
    beforeEach(() => {
        vi.resetModules();
        routerBackMock.mockClear();
        getPendingTerminalConnectMock.mockReset();
        globalWindow.window = {
            location: {
                hash: '#server=https%3A%2F%2Fexample.test&key=abcdefghijklmnop',
                pathname: '/terminal/connect',
                search: '',
            },
            history: { replaceState: vi.fn() },
        } as unknown as Window;
    });

    afterEach(() => {
        standardCleanup();
        if (originalWindow === undefined) {
            Reflect.deleteProperty(globalThis, 'window');
        } else {
            globalWindow.window = originalWindow;
        }
    });

    it('parses key even when it is not the first hash parameter', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        const renderedItems = screen.root.findAll((node) => (node.type as unknown) === 'Item');
        const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
        expect(publicKeyItem).toBeTruthy();
        expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
        expect(globalWindow.window?.history.replaceState).toHaveBeenCalled();
    });

    it('shows invalid-link state when hash contains no key parameter', async () => {
        globalWindow.window = {
            location: {
                hash: '#server=https%3A%2F%2Fexample.test',
                pathname: '/terminal/connect',
                search: '',
            },
            history: { replaceState: vi.fn() },
        } as unknown as Window;

        const Screen = (await import('@/app/(app)/terminal/connect')).default;
        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLink');
    });

    it('restores key from pending terminal connect when hash is empty (dev strict-mode remount safety)', async () => {
        getPendingTerminalConnectMock.mockReturnValue({
            publicKeyB64Url: 'abcdefghijklmnop',
            serverUrl: 'https://example.test',
        });

        globalWindow.window = {
            location: {
                hash: '',
                pathname: '/terminal/connect',
                search: '',
            },
            history: { replaceState: vi.fn() },
        } as unknown as Window;

        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        const renderedItems = screen.root.findAll((node) => (node.type as unknown) === 'Item');
        const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
        expect(publicKeyItem).toBeTruthy();
        expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
    });
});
