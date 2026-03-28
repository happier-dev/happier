import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import {
    installPromptTemplatesCommonModuleMocks,
    promptTemplatesRouterPushSpy,
} from './promptTemplatesScreenTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setInvocationsMock = vi.fn();
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));

installPromptTemplatesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ScrollView: 'ScrollView',
            View: 'View',
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
                    accent: { blue: '#00f' },
                    textSecondary: '#999',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: promptTemplatesRouterPushSpy },
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirmMock,
                alert: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
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
            useSettingMutable: () => [
                {
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
                },
                setInvocationsMock,
            ],
            useArtifacts: () => [
                { id: 'doc-1', title: 'Prompt One', header: { kind: 'prompt_doc.v2', title: 'Prompt One' } },
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

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.title ?? null, props.subtitle ?? null, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

describe('PromptTemplatesScreen', () => {
    beforeEach(() => {
        promptTemplatesRouterPushSpy.mockClear();
        setInvocationsMock.mockClear();
        modalConfirmMock.mockClear();
    });

    it('renders template entries before the add item and exposes row actions', async () => {
        const { PromptTemplatesScreen } = await import('./PromptTemplatesScreen');

        const screen = await renderScreen(React.createElement(PromptTemplatesScreen));

        expect(screen.findByTestId('promptTemplates.entry.template-1')).toBeTruthy();
        expect(screen.findByTestId('promptTemplates.add')).toBeTruthy();
        const textContent = screen.getTextContent();
        expect(textContent.indexOf('Daily')).toBeLessThan(textContent.indexOf('promptLibrary.newTemplate'));

        const actions = findTestInstanceByTypeWithProps(screen.tree, 'ItemRowActions' as any, {
            title: 'Daily',
        }) as any;
        expect(actions).toBeTruthy();
        expect(actions.props?.actions?.map((action: any) => action.id)).toEqual([
            'edit',
            'delete',
        ]);
    });
});
