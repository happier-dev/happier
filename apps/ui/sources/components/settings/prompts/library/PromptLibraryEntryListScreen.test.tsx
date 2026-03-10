import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const deleteArtifactMock = vi.hoisted(() => vi.fn(async () => undefined));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const duplicatePromptDocMock = vi.hoisted(() => vi.fn(async () => 'doc-1-copy'));
const duplicatePromptBundleMock = vi.hoisted(() => vi.fn(async () => 'bundle-1-copy'));
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const setPromptInvocationsMock = vi.fn();
const setPromptStacksMock = vi.fn();
const setPromptExternalLinksMock = vi.fn();
const setPromptFoldersMock = vi.fn();

const useArtifactsMock = vi.hoisted(() => vi.fn(() => [
    {
        id: 'doc-1',
        title: 'Prompt One',
        header: { kind: 'prompt_doc.v2', title: 'Prompt One', origin: 'user', folderId: 'folder-1', tags: ['urgent', 'release'] },
    },
    {
        id: 'doc-2',
        title: 'Prompt Two',
        header: { kind: 'prompt_doc.v2', title: 'Prompt Two', origin: 'imported', tags: ['docs'] },
    },
]));

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (fn: any) => fn({
            colors: {
                groupped: { background: 'white' },
                textSecondary: '#999',
                input: { background: '#fff', text: '#111', placeholder: '#666' },
                accent: { blue: '#00f', indigo: '#60f', purple: '#90f' },
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: 'white' },
                textSecondary: '#999',
                input: { background: '#fff', text: '#111', placeholder: '#666' },
                accent: { blue: '#00f', indigo: '#60f', purple: '#90f' },
                deleteAction: '#f00',
                button: { secondary: { tint: '#777' } },
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

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/forms/settingsTextInputMetrics', () => ({
    SETTINGS_TEXT_INPUT_METRICS: {},
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: modalConfirmMock,
        alert: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useArtifacts: () => useArtifactsMock(),
    useAllMachines: () => [],
    useSettingMutable: (key: string) => {
        if (key === 'promptInvocationsV1') return [{ v: 1, entries: [{ id: 'template-1', target: { kind: 'doc', artifactId: 'doc-1' } }] }, setPromptInvocationsMock];
        if (key === 'promptStacksV1') {
            return [{
                v: 1,
                surfaces: {
                    coding: [{ id: 'stack-1', ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' }],
                    voice: [],
                    profilesById: {},
                },
            }, setPromptStacksMock];
        }
        if (key === 'promptExternalLinksV1') {
            return [{
                v: 1,
                links: [
                    {
                        id: 'link-1',
                        artifactId: 'doc-1',
                        assetTypeId: 'claude.command',
                        machineId: 'machine-1',
                        scope: 'user',
                        workspacePath: null,
                        externalRef: { relativePath: 'qa.md' },
                        lastExternalDigest: 'digest-1',
                    },
                ],
            }, setPromptExternalLinksMock];
        }
        if (key === 'promptFoldersV1') {
            return [{
                v: 1,
                folders: [
                    { id: 'folder-1', name: 'Ops', parentId: null },
                ],
            }, setPromptFoldersMock];
        }
        return [null, vi.fn()];
    },
    storage: {
        getState: () => ({
            deleteArtifact: vi.fn(),
        }),
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'token' }),
    },
}));

vi.mock('@/sync/api/artifacts/apiArtifacts', () => ({
    deleteArtifact: deleteArtifactMock,
}));

vi.mock('@/sync/ops/promptLibrary/promptDocs', async () => {
    const actual = await vi.importActual<any>('@/sync/ops/promptLibrary/promptDocs');
    return {
        ...actual,
        duplicatePromptDoc: duplicatePromptDocMock,
    };
});

vi.mock('@/sync/ops/promptLibrary/promptBundles', async () => {
    const actual = await vi.importActual<any>('@/sync/ops/promptLibrary/promptBundles');
    return {
        ...actual,
        duplicatePromptBundle: duplicatePromptBundleMock,
    };
});

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('PromptLibraryEntryListScreen', () => {
    beforeEach(() => {
        deleteArtifactMock.mockClear();
        modalConfirmMock.mockClear();
        routerPushSpy.mockClear();
        routerBackSpy.mockClear();
        setPromptInvocationsMock.mockClear();
        setPromptStacksMock.mockClear();
        setPromptExternalLinksMock.mockClear();
        setPromptFoldersMock.mockClear();
        duplicatePromptDocMock.mockClear();
        duplicatePromptBundleMock.mockClear();
    });

    it('renders entries before the add item and exposes row actions for each prompt', async () => {
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptLibraryEntryListScreen, { kind: 'doc' }));
        });

        const items = tree.root.findAllByType('Item');
        expect(items.map((node) => node.props?.testID)).toEqual([
            'promptLibrary.entry.doc.doc-1',
            'promptLibrary.entry.doc.doc-2',
            'promptLibrary.add.doc',
        ]);
        expect(items[0]?.props?.subtitle).toBe('Ops · urgent, release · promptLibrary.linkedAssetsCount · machine-1');
        expect(items[1]?.props?.subtitle).toBe('promptLibrary.imported · docs');

        const actionHosts = tree.root.findAllByType('ItemRowActions');
        expect(actionHosts).toHaveLength(2);
        expect(actionHosts[0]?.props?.actions?.map((action: any) => action.id)).toEqual([
            'edit',
            'duplicate',
            'external',
            'delete',
        ]);
    });


    it('filters the library list from the search field before the add row', async () => {
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptLibraryEntryListScreen, { kind: 'doc' }));
        });

        const searchInput = tree.root.findByProps({ testID: 'promptLibrary.search.doc' });

        await act(async () => {
            searchInput.props.onChangeText?.('urgent');
        });

        const items = tree.root.findAllByType('Item');
        expect(items.map((node) => node.props?.testID)).toEqual([
            'promptLibrary.entry.doc.doc-1',
            'promptLibrary.add.doc',
        ]);
    });

    it('deletes a prompt artifact and prunes linked template, stack, and external-link references', async () => {
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptLibraryEntryListScreen, { kind: 'doc' }));
        });

        const actions = tree.root.findAllByType('ItemRowActions');
        const deleteAction = actions[0]?.props?.actions?.find((action: any) => action.id === 'delete');
        expect(deleteAction).toBeTruthy();

        await act(async () => {
            await deleteAction?.onPress?.();
        });

        expect(deleteArtifactMock).toHaveBeenCalledWith({ token: 'token' }, 'doc-1');
        expect(setPromptInvocationsMock).toHaveBeenCalledWith({ v: 1, entries: [] });
        expect(setPromptStacksMock).toHaveBeenCalledWith({
            v: 1,
            surfaces: {
                coding: [],
                voice: [],
                profilesById: {},
            },
        });
        expect(setPromptExternalLinksMock).toHaveBeenCalledWith({ v: 1, links: [] });
    });

    it('duplicates a prompt artifact and routes to the new editor entry', async () => {
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptLibraryEntryListScreen, { kind: 'doc' }));
        });

        const actions = tree.root.findAllByType('ItemRowActions');
        const duplicateAction = actions[0]?.props?.actions?.find((action: any) => action.id === 'duplicate');
        expect(duplicateAction).toBeTruthy();

        await act(async () => {
            await duplicateAction?.onPress?.();
        });

        expect(duplicatePromptDocMock).toHaveBeenCalledWith('doc-1');
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/docs/doc-1-copy');
    });
});
