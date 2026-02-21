import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackMock = vi.fn();
const localSearchParamsMock = vi.fn((): Record<string, string> => ({ server: 'https://example.test' }));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: routerBackMock }),
    useLocalSearchParams: () => localSearchParamsMock(),
}));

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

vi.mock('react-native', () => ({
    View: 'View',
}));

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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { textDestructive: '#f00', textSecondary: '#666', radio: { active: '#0af' }, text: '#000' } },
    }),
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

describe('TerminalScreen legacy deep-link fallback', () => {
    beforeEach(() => {
        vi.resetModules();
        routerBackMock.mockClear();
        localSearchParamsMock.mockReset();
        localSearchParamsMock.mockReturnValue({ server: 'https://example.test' });
    });

    it('does not treat known params like server as a legacy public key', async () => {
        const Screen = (await import('./index')).default;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});
            if (!tree) {
                throw new Error('Expected terminal index renderer');
            }

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

    it('uses legacy fallback when exactly one unknown search param key is present', async () => {
        localSearchParamsMock.mockReturnValue({ abcdefghijklmnop: '' });
        const Screen = (await import('./index')).default;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});
            if (!tree) {
                throw new Error('Expected terminal index renderer');
            }

            const renderedItems = tree.root.findAll((node) => (node.type as unknown) === 'Item');
            const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
            expect(publicKeyItem).toBeTruthy();
            expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
