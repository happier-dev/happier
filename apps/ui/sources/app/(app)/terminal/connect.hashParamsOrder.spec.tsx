import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackMock = vi.fn();
const globalWindow = globalThis as unknown as { window?: Window };
const originalWindow = globalWindow.window;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: routerBackMock }),
}));

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/sync/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: vi.fn(async () => true),
}));

vi.mock('@/hooks/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ processAuthUrl: vi.fn(async () => {}), isLoading: false }),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Platform: {
        OS: 'web',
        select: (options: Record<string, unknown>) => options.web ?? options.default,
    },
}));

vi.mock('@/components/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/RoundButton', () => ({
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
        globalWindow.window = {
            location: {
                hash: '#server=https%3A%2F%2Fexample.test&key=abcdefghijklmnop',
                pathname: '/terminal/connect',
                search: '',
            },
            history: { replaceState: vi.fn() },
        } as Window;
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            Reflect.deleteProperty(globalThis, 'window');
        } else {
            globalWindow.window = originalWindow;
        }
    });

    it('parses key even when it is not the first hash parameter', async () => {
        const Screen = (await import('./connect')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});

            const renderedItems = tree.root.findAll((node) => node.type === 'Item');
            const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
            expect(publicKeyItem).toBeTruthy();
            expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
            expect(globalWindow.window?.history.replaceState).toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('shows invalid-link state when hash contains no key parameter', async () => {
        globalWindow.window = {
            location: {
                hash: '#server=https%3A%2F%2Fexample.test',
                pathname: '/terminal/connect',
                search: '',
            },
            history: { replaceState: vi.fn() },
        } as Window;

        const Screen = (await import('./connect')).default;
        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});

            const textValues = tree.root
                .findAll((node) => typeof node.props?.children === 'string')
                .map((node) => String(node.props.children));
            expect(textValues).toContain('terminal.invalidConnectionLink');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
