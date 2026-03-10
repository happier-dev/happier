import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const setInvocationsMock = vi.fn();

vi.mock('react-native', () => ({
    ScrollView: 'ScrollView',
    View: 'View',
    Switch: 'Switch',
    Platform: { OS: 'web', select: ({ web, default: defaultValue }: any) => web ?? defaultValue },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (fn: any) => fn({
            colors: {
                groupped: { background: 'white' },
                input: { background: '#fff', text: '#111', placeholder: '#666' },
                accent: { blue: '#00f', indigo: '#60f' },
                textSecondary: '#999',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: 'white' },
                input: { background: '#fff', text: '#111', placeholder: '#666' },
                accent: { blue: '#00f', indigo: '#60f' },
                textSecondary: '#999',
                textDestructive: '#f00',
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ push: routerPushSpy, back: routerBackSpy }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/settingsSurface/SettingsActionFooter', () => ({
    SettingsActionFooter: (props: any) => React.createElement('SettingsActionFooter', props),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useArtifacts: () => ([
        { id: 'doc-1', title: 'Prompt One', header: { kind: 'prompt_doc.v2', title: 'Prompt One' } },
        { id: 'doc-2', title: 'Prompt Two', header: { kind: 'prompt_doc.v2', title: 'Prompt Two' } },
    ]),
    useSettingMutable: () => [{
        v: 1,
        entries: [],
    }, setInvocationsMock],
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'template-1',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('PromptTemplateEditorScreen', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        routerBackSpy.mockClear();
        setInvocationsMock.mockClear();
    });

    it('uses a dropdown selector for the target prompt and exposes create/edit prompt actions', async () => {
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptTemplateEditorScreen, { invocationId: null }));
        });

        const dropdown = tree.root.findByType('DropdownMenu');
        expect(dropdown.props?.selectedId).toBe('');
        expect(dropdown.props?.items?.map((item: any) => item.id)).toEqual(['doc-1', 'doc-2']);

        const items = tree.root.findAllByType('Item');
        expect(items.map((node) => node.props?.testID)).toContain('promptTemplate.target.edit');
        expect(items.map((node) => node.props?.testID)).toContain('promptTemplate.target.new');

        const footer = tree.root.findByType('SettingsActionFooter');
        expect(footer.props.primaryTestID).toBe('promptTemplate.save');
        expect(footer.props.secondaryTestID).toBe('promptTemplate.cancel');
    });
});
