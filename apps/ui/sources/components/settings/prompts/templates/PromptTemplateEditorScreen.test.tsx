import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installPromptTemplatesCommonModuleMocks,
    promptTemplatesRouterBackSpy,
    promptTemplatesRouterPushSpy,
} from './promptTemplatesScreenTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setInvocationsMock = vi.fn();

installPromptTemplatesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ScrollView: 'ScrollView',
            View: 'View',
            Switch: 'Switch',
            Platform: {
                OS: 'web',
                select: ({ web, default: defaultValue }: { web?: unknown; default?: unknown }) =>
                    web ?? defaultValue,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: 'white' },
                    input: { background: '#fff', text: '#111', placeholder: '#666' },
                    accent: { blue: '#00f', indigo: '#60f' },
                    textSecondary: '#999',
                    textDestructive: '#f00',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: promptTemplatesRouterPushSpy, back: promptTemplatesRouterBackSpy },
        });
        return routerMock.module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useArtifacts: () => [
                { id: 'doc-1', title: 'Prompt One', header: { kind: 'prompt_doc.v2', title: 'Prompt One' } },
                { id: 'doc-2', title: 'Prompt Two', header: { kind: 'prompt_doc.v2', title: 'Prompt Two' } },
            ],
            useSettingMutable: () => [
                {
                    v: 1,
                    entries: [],
                },
                setInvocationsMock,
            ],
        });
    },
});

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
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', {
        ...props,
        testID: 'promptTemplate.target',
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/settingsSurface/SettingsActionFooter', () => ({
    SettingsActionFooter: (props: any) => React.createElement('SettingsActionFooter', {
        ...props,
        testID: 'promptTemplate.footer',
    }),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'template-1',
}));

describe('PromptTemplateEditorScreen', () => {
    beforeEach(() => {
        promptTemplatesRouterPushSpy.mockClear();
        promptTemplatesRouterBackSpy.mockClear();
        setInvocationsMock.mockClear();
    });

    it('uses a dropdown selector for the target prompt and exposes create/edit prompt actions', async () => {
        const { PromptTemplateEditorScreen } = await import('./PromptTemplateEditorScreen');

        const screen = await renderScreen(React.createElement(PromptTemplateEditorScreen, { invocationId: null }));

        const dropdown = screen.findByTestId('promptTemplate.target');
        expect(dropdown?.props?.selectedId).toBe('');
        expect(dropdown?.props?.items?.map((item: any) => item.id)).toEqual(['doc-1', 'doc-2']);

        expect(screen.findByTestId('promptTemplate.target.edit')).toBeTruthy();
        expect(screen.findByTestId('promptTemplate.target.new')).toBeTruthy();
        expect(screen.findByTestId('promptTemplate.behavior.insert_on_send')).toBeTruthy();

        const footer = screen.findByTestId('promptTemplate.footer');
        expect(footer?.props.primaryTestID).toBe('promptTemplate.save');
        expect(footer?.props.secondaryTestID).toBe('promptTemplate.cancel');
    });
});
