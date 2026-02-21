import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearPendingMock = vi.fn();

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
    useLocalSearchParams: () => ({ key: 'abc123', server: 'https://example.test' }),
}));

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

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { textDestructive: '#f00', textSecondary: '#666', radio: { active: '#0af' }, text: '#000', success: '#0a0' } },
    }),
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

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props, null),
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

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://api.happier.dev',
}));

describe('TerminalScreen authenticated buttons', () => {
    beforeEach(() => {
        vi.resetModules();
        clearPendingMock.mockClear();
    });

    it('exposes stable testIDs for approve/reject buttons on /terminal', async () => {
        const Screen = (await import('./index')).default;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});

            const buttonTestIds = tree!.root
                .findAll((node) => (node.type as any) === 'RoundButton')
                .map((node) => node.props?.testID)
                .filter(Boolean);

            expect(buttonTestIds).toContain('terminal-connect-approve');
            expect(buttonTestIds).toContain('terminal-connect-reject');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});

