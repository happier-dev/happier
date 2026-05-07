import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installPromptStacksCommonModuleMocks,
    promptStacksRouterBackSpy,
    promptStacksRouterPushSpy,
} from './promptStacksScreenTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setPromptStacksMock = vi.fn();

installPromptStacksCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: promptStacksRouterPushSpy,
                back: promptStacksRouterBackSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useArtifacts: () => ([
                { id: 'doc-1', title: 'Prompt One', header: { kind: 'prompt_doc.v2', title: 'Prompt One' } },
                { id: 'bundle-1', title: 'Skill One', header: { kind: 'prompt_bundle.v2', title: 'Skill One' } },
            ]),
            useSettingMutable: () => [{
                v: 1,
                surfaces: { coding: [], voice: [], profilesById: {} },
            }, setPromptStacksMock],
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: 'white' },
                    accent: { blue: '#00f' },
                    textSecondary: '#999',
                },
            },
        });
    },
});

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

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'entry-new',
}));

describe('PromptStackPromptPickerScreen', () => {
    beforeEach(() => {
        promptStacksRouterPushSpy.mockClear();
        promptStacksRouterBackSpy.mockClear();
        setPromptStacksMock.mockClear();
    });

    it('lets users edit existing prompts and create new prompts or skills from the picker', async () => {
        const { PromptStackPromptPickerScreen } = await import('./PromptStackPromptPickerScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptStackPromptPickerScreen, {
                surface: 'coding',
            }))).tree;

        const actions = tree.findAllByType('ItemRowActions');
        expect(actions).toHaveLength(2);

        const editPromptAction = actions[0]?.props?.actions?.find((action: any) => action.id === 'edit');
        expect(editPromptAction).toBeTruthy();
        await act(async () => {
            editPromptAction?.onPress?.();
        });
        expect(promptStacksRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/docs/doc-1');

        const addPromptItem = tree.findByTestId('promptStackPicker.addPrompt');
        const addSkillItem = tree.findByTestId('promptStackPicker.addSkill');
        expect(addPromptItem).toBeTruthy();
        expect(addSkillItem).toBeTruthy();
    });
});
