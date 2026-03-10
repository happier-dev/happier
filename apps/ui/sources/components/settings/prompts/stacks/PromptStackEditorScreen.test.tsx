import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const setPromptStacksMock = vi.fn();

vi.mock('react-native', () => ({
    ScrollView: 'ScrollView',
    View: 'View',
    Switch: 'Switch',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (fn: any) => fn({
            colors: {
                groupped: { background: 'white' },
                accent: { blue: '#00f' },
                textSecondary: '#999',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: 'white' },
                accent: { blue: '#00f' },
                textSecondary: '#999',
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useArtifacts: () => ([
        { id: 'doc-1', title: 'Prompt One', header: { kind: 'prompt_doc.v2', title: 'Prompt One' } },
    ]),
    useSettingMutable: () => [{
        v: 1,
        surfaces: {
            coding: [
                {
                    id: 'entry-1',
                    ref: { kind: 'doc', artifactId: 'doc-1' },
                    enabled: true,
                    placement: 'system_append',
                    editPolicy: 'user_only',
                },
            ],
            voice: [],
            profilesById: {},
        },
    }, setPromptStacksMock],
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('PromptStackEditorScreen', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        setPromptStacksMock.mockClear();
    });

    it('renders stack entries with row actions and keeps add item at the bottom', async () => {
        const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptStackEditorScreen, {
                surface: 'coding',
                title: 'System Prompt Additions',
            }));
        });

        const items = tree.root.findAllByType('Item');
        expect(items.map((node) => node.props?.testID)).toEqual([
            'promptStack.entry.entry-1',
            'promptStack.add',
        ]);

        const actions = tree.root.findAllByType('ItemRowActions');
        expect(actions).toHaveLength(1);
        expect(actions[0]?.props?.actions?.map((action: any) => action.id)).toEqual([
            'edit',
            'moveUp',
            'moveDown',
            'delete',
        ]);
    });
});
