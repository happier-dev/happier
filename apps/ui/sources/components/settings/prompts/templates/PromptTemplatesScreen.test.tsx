import * as React from 'react';
import { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const setInvocationsMock = vi.fn();
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            ScrollView: 'ScrollView',
                                            View: 'View',
                                            Platform: {
                                                OS: 'web',
                                                select: ({ web, default: defaultValue }: any) => web ?? defaultValue,
                                            },
                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
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
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: modalConfirmMock,
            alert: vi.fn(),
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
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
});
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('PromptTemplatesScreen', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        setInvocationsMock.mockClear();
        modalConfirmMock.mockClear();
    });

    it('renders template entries before the add item and exposes row actions', async () => {
        const { PromptTemplatesScreen } = await import('./PromptTemplatesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptTemplatesScreen))).tree;

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
