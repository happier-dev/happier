import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const setInvocationsMock = vi.fn();
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', () => ({
    ScrollView: 'ScrollView',
    View: 'View',
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
        confirm: modalConfirmMock,
        alert: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'promptInvocationsV1') {
            return {
                v: 1,
                entries: [
                    {
                        id: 'template-1',
                        token: '/daily',
                        title: 'Daily',
                        target: { kind: 'doc', artifactId: 'doc-1' },
                        behavior: 'insert',
                        allowArgs: false,
                        availableIn: 'global',
                    },
                ],
            };
        }
        return null;
    },
    useSettingMutable: () => [{
        v: 1,
        entries: [
            {
                id: 'template-1',
                token: '/daily',
                title: 'Daily',
                target: { kind: 'doc', artifactId: 'doc-1' },
                behavior: 'insert',
                allowArgs: false,
                availableIn: 'global',
            },
        ],
    }, setInvocationsMock],
    useArtifacts: () => ([
        { id: 'doc-1', title: 'Prompt One', header: { kind: 'prompt_doc.v2', title: 'Prompt One' } },
    ]),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('PromptTemplatesScreen', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        setInvocationsMock.mockClear();
        modalConfirmMock.mockClear();
    });

    it('renders template entries before the add item and exposes row actions', async () => {
        const { PromptTemplatesScreen } = await import('./PromptTemplatesScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptTemplatesScreen));
        });

        const items = tree.root.findAllByType('Item');
        expect(items.map((node) => node.props?.testID)).toEqual([
            'promptTemplates.entry.template-1',
            'promptTemplates.add',
        ]);

        const actions = tree.root.findAllByType('ItemRowActions');
        expect(actions).toHaveLength(1);
        expect(actions[0]?.props?.actions?.map((action: any) => action.id)).toEqual([
            'edit',
            'delete',
        ]);
    });
});
