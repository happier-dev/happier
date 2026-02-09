import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-typography', () => ({
    human: {},
    iOSUIKit: {},
    material: {},
}));

vi.mock('react-native', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        KeyboardAvoidingView: 'KeyboardAvoidingView',
        Platform: { ...actual.Platform, OS: 'ios' },
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                groupped: { background: '#fff' },
                text: '#000',
                textSecondary: '#666',
                textDestructive: '#f00',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                status: { connecting: '#00f' },
                divider: '#ccc',
            },
        },
    }),
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-updates', () => ({
    reloadAsync: vi.fn(),
}));

const routerReplaceMock = vi.fn();
let localSearchParamsMock: Record<string, any> = {};
const switchConnectionToActiveServerSpy = vi.fn(async () => null);
const refreshFromActiveServerSpy = vi.fn(async () => {});

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: any) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }
    ),
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: routerReplaceMock }),
    useLocalSearchParams: () => localSearchParamsMock,
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: (...args: unknown[]) => switchConnectionToActiveServerSpy(...args),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, subtitle }: any) => React.createElement('Text', null, `${title}${subtitle ? ` ${subtitle}` : ''}`),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => null,
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: ({ title }: any) => React.createElement('Text', null, title),
}));

describe('ServerConfigScreen', () => {
    it('renders saved server profiles', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
        setActiveServerId('official', { scope: 'device' });

        const Screen = (await import('./server')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        expect(tree).toBeTruthy();
        const rendered = tree!.toJSON();
        expect(rendered).toBeTruthy();
        expect(JSON.stringify(rendered)).toContain('Company');
        expect(JSON.stringify(rendered)).toContain('Happier Cloud');
        expect(JSON.stringify(rendered)).toContain('Enable concurrent view');
    });

    it('auto=1 upserts and activates server then redirects away', async () => {
        localSearchParamsMock = { url: 'https://company.example.test', auto: '1' };
        routerReplaceMock.mockClear();
        switchConnectionToActiveServerSpy.mockClear();
        refreshFromActiveServerSpy.mockClear();

        (globalThis as any).fetch = vi.fn(async () => ({ ok: true, text: async () => 'Welcome to Happier Server!' }));

        const { getActiveServerId, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        setActiveServerId('official', { scope: 'device' });

        const Screen = (await import('./server')).default;

        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });
        await act(async () => {});

        expect(getActiveServerId()).not.toEqual('official');
        expect(switchConnectionToActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(refreshFromActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceMock).toHaveBeenCalledWith('/');
    });
});
