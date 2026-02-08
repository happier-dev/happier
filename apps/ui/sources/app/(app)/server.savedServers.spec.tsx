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

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: any) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }
    ),
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
    useLocalSearchParams: () => ({}),
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

vi.mock('@/components/RoundButton', () => ({
    RoundButton: ({ title }: any) => React.createElement('Text', null, title),
}));

describe('ServerConfigScreen', () => {
    it('renders saved server profiles', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/serverProfiles');
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
        expect(JSON.stringify(rendered)).toContain('Happier (Official)');
    });
});
