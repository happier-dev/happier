import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-typography', () => ({
    human: {},
    iOSUIKit: {},
    material: {},
}));

const capturedActions = vi.hoisted(() => ({
    rows: [] as Array<{ title: string; actions: Array<{ id: string; title: string }> }>,
    reset() {
        this.rows = [];
    },
}));

vi.mock('react-native', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        KeyboardAvoidingView: 'KeyboardAvoidingView',
        Platform: { ...actual.Platform, OS: 'web' },
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
                status: { connecting: '#00f', connected: '#0f0' },
                divider: '#ccc',
                button: { secondary: { tint: '#333' } },
                deleteAction: '#f00',
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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: any) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }
    ),
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
    useLocalSearchParams: () => ({}),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => null),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, subtitle, rightElement }: any) => React.createElement(
        React.Fragment,
        null,
        React.createElement('Text', null, `${title}${subtitle ? ` ${subtitle}` : ''}`),
        rightElement ?? null,
    ),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: ({ title, actions }: any) => {
        capturedActions.rows.push({ title, actions });
        return null;
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: ({ title }: any) => React.createElement('Text', null, title),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: () => null,
}));

afterEach(() => {
    capturedActions.reset();
});

describe('ServerConfigScreen (web row actions)', () => {
    it('adds per-row device switch action for server rows on web', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
        setActiveServerId('cloud', { scope: 'device' });

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
        });

        const companyRow = capturedActions.rows.find((row) => row.title === 'Company');
        expect(companyRow).toBeTruthy();
        const actionIds = new Set((companyRow?.actions ?? []).map((a) => a.id));
        expect(actionIds.has('switch-device')).toBe(true);
        expect(actionIds.has('switch-tab')).toBe(false);
    }, 40_000);
});
