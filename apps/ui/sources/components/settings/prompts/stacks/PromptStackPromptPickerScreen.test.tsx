import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const setPromptStacksMock = vi.fn();

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
    useRouter: () => ({ push: routerPushSpy, back: routerBackSpy }),
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

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'entry-new',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useArtifacts: () => ([
        { id: 'doc-1', title: 'Prompt One', header: { kind: 'prompt_doc.v2', title: 'Prompt One' } },
        { id: 'bundle-1', title: 'Skill One', header: { kind: 'prompt_bundle.v2', title: 'Skill One' } },
    ]),
    useSettingMutable: () => [{
        v: 1,
        surfaces: { coding: [], voice: [], profilesById: {} },
    }, setPromptStacksMock],
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('PromptStackPromptPickerScreen', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        routerBackSpy.mockClear();
        setPromptStacksMock.mockClear();
    });

    it('lets users edit existing prompts and create new prompts or skills from the picker', async () => {
        const { PromptStackPromptPickerScreen } = await import('./PromptStackPromptPickerScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptStackPromptPickerScreen, {
                surface: 'coding',
            }));
        });

        const actions = tree.root.findAllByType('ItemRowActions');
        expect(actions).toHaveLength(2);

        const editPromptAction = actions[0]?.props?.actions?.find((action: any) => action.id === 'edit');
        expect(editPromptAction).toBeTruthy();
        await act(async () => {
            editPromptAction?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/docs/doc-1');

        const addPromptItem = tree.root.findAllByType('Item').find((node) => node.props?.testID === 'promptStackPicker.addPrompt');
        const addSkillItem = tree.root.findAllByType('Item').find((node) => node.props?.testID === 'promptStackPicker.addSkill');
        expect(addPromptItem).toBeTruthy();
        expect(addSkillItem).toBeTruthy();
    });
});
