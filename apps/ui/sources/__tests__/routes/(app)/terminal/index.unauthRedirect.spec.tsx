import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
const setPendingMock = vi.fn();
let searchParamsServerValue: string | null = 'https://example.test';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: vi.fn(), replace: replaceMock }),
    useLocalSearchParams: () => ({ key: 'abc123', server: searchParamsServerValue }),
}));

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
        theme: { colors: { textDestructive: '#f00', textSecondary: '#666', radio: { active: '#0af' }, text: '#000', success: '#0a0' } },
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
    Item: () => null,
}));

describe('TerminalScreen unauthenticated redirect', () => {
    beforeEach(() => {
        vi.resetModules();
        replaceMock.mockClear();
        setPendingMock.mockClear();
        searchParamsServerValue = 'https://example.test';
    });

    it('stores pending connect and redirects to auth screen immediately', async () => {
        const Screen = (await import('@/app/(app)/terminal/index')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
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

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(setPendingMock).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://api.happier.dev',
        });
        expect(replaceMock).toHaveBeenCalledWith('/');
    });
});
