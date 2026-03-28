import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installPromptStacksCommonModuleMocks,
    promptStacksRouterPushSpy,
} from './promptStacksScreenTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setPromptStacksMock = vi.fn();

installPromptStacksCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useArtifacts: () => ([
                {
                    id: 'doc-1',
                    title: 'Prompt One',
                    header: { kind: 'prompt_doc.v2', title: 'Prompt One' },
                },
            ]),
            useSettingMutable: () => [
                {
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
                },
                setPromptStacksMock,
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
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

describe('PromptStackEditorScreen', () => {
    beforeEach(() => {
        promptStacksRouterPushSpy.mockClear();
        setPromptStacksMock.mockClear();
    });

    it('renders stack entries with row actions and keeps add item at the bottom', async () => {
        const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');

        const screen = await renderScreen(React.createElement(PromptStackEditorScreen, {
                surface: 'coding',
                title: 'System Prompt Additions',
            }));

        const group = screen.findAllByType('ItemGroup' as any)[0];
        expect(group).toBeTruthy();
        if (!group) {
            throw new Error('Expected stack entries group');
        }
        expect(React.Children.toArray(group.props.children).map((child: any) => child.props?.testID)).toEqual([
            'promptStack.entry.entry-1',
        ]);

        const addGroup = screen.findAllByType('ItemGroup' as any)[1];
        expect(addGroup).toBeTruthy();
        if (!addGroup) {
            throw new Error('Expected add group');
        }
        expect(React.Children.toArray(addGroup.props.children).map((child: any) => child.props?.testID)).toEqual([
            'promptStack.add',
        ]);

        expect(screen.findByTestId('promptStack.entry.entry-1')).toBeTruthy();
        expect(screen.findByTestId('promptStack.add')).toBeTruthy();

        const actions = screen.findAllByType('ItemRowActions' as any)[0];
        expect(actions).toBeTruthy();
        expect(actions?.props?.actions?.map((action: any) => action.id)).toEqual([
            'edit',
            'moveUp',
            'moveDown',
            'delete',
        ]);
    });
});
