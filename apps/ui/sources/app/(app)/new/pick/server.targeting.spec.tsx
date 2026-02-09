import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    rows: [] as Array<{ id: string; title: string }>,
    reset() {
        this.rows = [];
    },
}));

const state = vi.hoisted(() => ({
    activeServerId: 'server-a',
    activeServerUrl: 'https://stack-a.example.test',
    settings: {
        multiServerEnabled: false,
        multiServerSelectedServerIds: ['server-a'],
        multiServerPresentation: 'grouped' as const,
        multiServerProfiles: [] as Array<{ id: string; serverIds: string[]; presentation?: 'grouped' | 'flat-with-badge' }>,
        multiServerActiveProfileId: null as string | null,
    },
    profiles: [
        { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A', lastUsedAt: 1000 },
        { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B', lastUsedAt: 900 },
        { id: 'server-c', serverUrl: 'https://stack-c.example.test', name: 'Server C', lastUsedAt: 800 },
    ],
}));

const navigationDispatchSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        Platform: { ...actual.Platform, OS: 'web' },
        Pressable: 'Pressable',
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                header: { tint: '#111' },
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({
            type: 'SET_PARAMS',
            payload: { params },
        }),
    },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => (state.settings as any)[key],
}));

vi.mock('@/sync/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({
        serverId: state.activeServerId,
        serverUrl: state.activeServerUrl,
        kind: 'stack',
        generation: 1,
    }),
    listServerProfiles: () => state.profiles,
}));

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: any) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }
    ),
    useRouter: () => ({ back: routerBackSpy }),
    useNavigation: () => ({
        getState: () => ({
            index: 1,
            routes: [{ key: 'prev-route' }, { key: 'current-route' }],
        }),
        dispatch: navigationDispatchSpy,
    }),
    useLocalSearchParams: () => ({}),
}));

vi.mock('@/components/navigation/HeaderTitleWithAction', () => ({
    HeaderTitleWithAction: ({ title }: { title: string }) => React.createElement('Text', null, title),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title }: any) => {
        capture.rows.push({ id: String(title ?? ''), title: String(title ?? '') });
        return null;
    },
}));

beforeEach(() => {
    capture.reset();
    navigationDispatchSpy.mockReset();
    routerBackSpy.mockReset();
    state.activeServerId = 'server-a';
    state.activeServerUrl = 'https://stack-a.example.test';
    state.settings = {
        multiServerEnabled: false,
        multiServerSelectedServerIds: ['server-a'],
        multiServerPresentation: 'grouped',
        multiServerProfiles: [],
        multiServerActiveProfileId: null,
    };
    state.profiles = [
        { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A', lastUsedAt: 1000 },
        { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B', lastUsedAt: 900 },
        { id: 'server-c', serverUrl: 'https://stack-c.example.test', name: 'Server C', lastUsedAt: 800 },
    ];
});

afterEach(() => {
    capture.reset();
});

describe('new-session server picker targeting', () => {
    it('shows only the active server when concurrent mode is disabled', async () => {
        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        const titles = capture.rows.map((row) => row.title);
        expect(titles).toEqual(['Server A']);
    });

    it('shows selected server targets when concurrent mode is enabled', async () => {
        state.settings.multiServerEnabled = true;
        state.settings.multiServerSelectedServerIds = ['server-a', 'server-c'];

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        const titles = capture.rows.map((row) => row.title);
        expect(titles).toEqual(['Server A', 'Server C']);
        expect(titles).not.toContain('Server B');
    });
});
