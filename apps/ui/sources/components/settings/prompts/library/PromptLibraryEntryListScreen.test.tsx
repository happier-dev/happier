import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installPromptLibrarySettingsCommonModuleMocks,
    promptLibrarySettingsRouterBackSpy,
    promptLibrarySettingsRouterPushSpy,
} from '../promptLibrarySettingsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const deleteArtifactMock = vi.hoisted(() => vi.fn(async () => undefined));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const duplicatePromptDocMock = vi.hoisted(() => vi.fn(async () => 'doc-1-copy'));
const duplicatePromptBundleMock = vi.hoisted(() => vi.fn(async () => 'bundle-1-copy'));
const modalAlertMock = vi.hoisted(() => vi.fn());
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

installPromptLibrarySettingsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirmMock,
                alert: modalAlertMock,
            },
        }).module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
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
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                push: promptLibrarySettingsRouterPushSpy,
                back: promptLibrarySettingsRouterBackSpy,
            },
        });
        return routerMock.module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
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
        });
    },
});

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

describe('PromptLibraryEntryListScreen', () => {
    beforeEach(() => {
        deleteArtifactMock.mockClear();
        modalConfirmMock.mockClear();
        promptLibrarySettingsRouterPushSpy.mockClear();
        promptLibrarySettingsRouterBackSpy.mockClear();
        setPromptInvocationsMock.mockClear();
        setPromptStacksMock.mockClear();
        setPromptExternalLinksMock.mockClear();
        setPromptFoldersMock.mockClear();
        duplicatePromptDocMock.mockClear();
        duplicatePromptBundleMock.mockClear();
        modalAlertMock.mockClear();
    });

    it('renders entries, subtitles, row actions, and the add item', async () => {
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        const screen = await renderScreen(<PromptLibraryEntryListScreen kind="doc" />);

        const firstEntry = screen.findByTestId('promptLibrary.entry.doc.doc-1');
        const secondEntry = screen.findByTestId('promptLibrary.entry.doc.doc-2');
        const addEntry = screen.findByTestId('promptLibrary.add.doc');

        expect(firstEntry).toBeTruthy();
        expect(secondEntry).toBeTruthy();
        expect(addEntry).toBeTruthy();
        expect(firstEntry?.props?.subtitle).toBe('Ops · urgent, release · promptLibrary.linkedAssetsCount · machine-1');
        expect(secondEntry?.props?.subtitle).toBe('promptLibrary.imported · docs');
        expect(firstEntry?.props?.rightElement?.props?.actions?.map((action: any) => action.id)).toEqual([
            'edit',
            'duplicate',
            'external',
            'delete',
        ]);
    });


    it('filters the library list from the search field before the add row', async () => {
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        const screen = await renderScreen(<PromptLibraryEntryListScreen kind="doc" />);

        await act(async () => {
            screen.changeTextByTestId('promptLibrary.search.doc', 'urgent');
        });

        expect(screen.findByTestId('promptLibrary.entry.doc.doc-1')).toBeTruthy();
        expect(screen.findByTestId('promptLibrary.entry.doc.doc-2')).toBeNull();
        expect(screen.findByTestId('promptLibrary.add.doc')).toBeTruthy();
    });

    it('deletes a prompt artifact and prunes linked template, stack, and external-link references', async () => {
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        const screen = await renderScreen(<PromptLibraryEntryListScreen kind="doc" />);
        const firstEntry = screen.findByTestId('promptLibrary.entry.doc.doc-1');
        const deleteAction = firstEntry?.props?.rightElement?.props?.actions?.find((action: any) => action.id === 'delete');
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

        const screen = await renderScreen(<PromptLibraryEntryListScreen kind="doc" />);
        const firstEntry = screen.findByTestId('promptLibrary.entry.doc.doc-1');
        const duplicateAction = firstEntry?.props?.rightElement?.props?.actions?.find((action: any) => action.id === 'duplicate');
        expect(duplicateAction).toBeTruthy();

        await act(async () => {
            await duplicateAction?.onPress?.();
        });

        expect(duplicatePromptDocMock).toHaveBeenCalledWith('doc-1');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/docs/doc-1-copy');
    });

    it('keeps local references unchanged when deleting a prompt artifact fails', async () => {
        deleteArtifactMock.mockRejectedValueOnce(new Error('delete failed'));
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        const screen = await renderScreen(<PromptLibraryEntryListScreen kind="doc" />);
        const firstEntry = screen.findByTestId('promptLibrary.entry.doc.doc-1');
        const deleteAction = firstEntry?.props?.rightElement?.props?.actions?.find((action: any) => action.id === 'delete');
        expect(deleteAction).toBeTruthy();

        await act(async () => {
            await deleteAction?.onPress?.();
        });

        expect(setPromptInvocationsMock).not.toHaveBeenCalled();
        expect(setPromptStacksMock).not.toHaveBeenCalled();
        expect(setPromptExternalLinksMock).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'errors.unknownError');
    });

    it('shows an error and stays on the current screen when duplication fails', async () => {
        duplicatePromptDocMock.mockRejectedValueOnce(new Error('copy failed'));
        const { PromptLibraryEntryListScreen } = await import('./PromptLibraryEntryListScreen');

        const screen = await renderScreen(<PromptLibraryEntryListScreen kind="doc" />);
        const firstEntry = screen.findByTestId('promptLibrary.entry.doc.doc-1');
        const duplicateAction = firstEntry?.props?.rightElement?.props?.actions?.find((action: any) => action.id === 'duplicate');
        expect(duplicateAction).toBeTruthy();

        await act(async () => {
            await duplicateAction?.onPress?.();
        });

        expect(promptLibrarySettingsRouterPushSpy).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'errors.unknownError');
    });
});
