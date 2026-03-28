import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installPromptLibrarySettingsCommonModuleMocks } from '../promptLibrarySettingsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const promptModalMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const confirmModalMock = vi.hoisted(() => vi.fn(async () => true));
const updatePromptDocMock = vi.hoisted(() => vi.fn(async () => undefined));
const updateSkillPromptBundleMock = vi.hoisted(() => vi.fn(async () => undefined));
const setPromptFoldersMock = vi.hoisted(() => vi.fn());

installPromptLibrarySettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
                    accent: { blue: '#00f', indigo: '#60f' },
                },
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: promptModalMock,
                confirm: confirmModalMock,
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useArtifacts: () => artifactsState.value,
            useSettingMutable: (key: string) => {
                if (key === 'promptFoldersV1') {
                    return [{
                        v: 1,
                        folders: [{ id: 'folder-1', name: 'Ops', parentId: null }],
                    }, setPromptFoldersMock];
                }
                return [null, vi.fn()];
            },
            storage: {
                getState: () => ({
                    updateArtifact: vi.fn(),
                }),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 960 },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
  ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/platform/randomUUID', () => ({
  randomUUID: () => 'folder-2',
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    fetchArtifactWithBody: vi.fn(async () => null),
  },
}));

vi.mock('@/sync/ops/promptLibrary/promptDocs', () => ({
  updatePromptDoc: updatePromptDocMock,
}));

vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({
  updateSkillPromptBundle: updateSkillPromptBundleMock,
  readSkillMarkdownFromPromptBundleBody: () => '# Skill',
}));

const artifactsState = vi.hoisted(() => ({
  value: [
    {
      id: 'doc-1',
      title: 'Doc One',
      header: { kind: 'prompt_doc.v2', title: 'Doc One', folderId: 'folder-1', tags: ['alpha'] },
      body: JSON.stringify({
        v: 1,
        markdown: '# Prompt',
        createdAtMs: 1,
        updatedAtMs: 2,
      }),
    },
  ],
}));

describe('PromptFoldersScreen', () => {
  beforeEach(() => {
    promptModalMock.mockReset();
    confirmModalMock.mockReset();
    updatePromptDocMock.mockClear();
    updateSkillPromptBundleMock.mockClear();
    setPromptFoldersMock.mockClear();
    artifactsState.value = [
      {
        id: 'doc-1',
        title: 'Doc One',
        header: { kind: 'prompt_doc.v2', title: 'Doc One', folderId: 'folder-1', tags: ['alpha'] },
        body: JSON.stringify({
          v: 1,
          markdown: '# Prompt',
          createdAtMs: 1,
          updatedAtMs: 2,
        }),
      },
    ];
  });

  it('adds a new folder from the prompt dialog', async () => {
    promptModalMock.mockResolvedValueOnce('Release' as string | null);
    const { PromptFoldersScreen } = await import('./PromptFoldersScreen');

    const screen = await renderScreen(<PromptFoldersScreen />);

    await screen.pressByTestIdAsync('promptFolders.add');

    expect(setPromptFoldersMock).toHaveBeenCalledWith({
      v: 1,
      folders: [
        { id: 'folder-1', name: 'Ops', parentId: null },
        { id: 'folder-2', name: 'Release', parentId: null },
      ],
    });
  });

  it('removes folder assignments from linked docs before deleting the folder', async () => {
    const { PromptFoldersScreen } = await import('./PromptFoldersScreen');

    const screen = await renderScreen(<PromptFoldersScreen />);

    const rowActions = findTestInstanceByTypeWithProps(screen.tree, 'ItemRowActions', { title: 'Ops' });
    expect(rowActions).toBeDefined();
    const deleteAction = rowActions?.props.actions.find((action: any) => action.id === 'delete');
    expect(deleteAction).toBeDefined();

    await act(async () => {
      await deleteAction?.onPress();
    });

    expect(updatePromptDocMock).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      title: 'Doc One',
      markdown: '# Prompt',
      folderId: null,
      tags: ['alpha'],
    });
    expect(setPromptFoldersMock).toHaveBeenCalledWith({
      v: 1,
      folders: [],
    });
  });

  it('skips malformed artifact bodies when deleting a folder', async () => {
    artifactsState.value = [
      {
        id: 'doc-1',
        title: 'Broken Doc',
        header: { kind: 'prompt_doc.v2', title: 'Broken Doc', folderId: 'folder-1', tags: ['alpha'] },
        body: '{',
      },
    ];

    const { PromptFoldersScreen } = await import('./PromptFoldersScreen');

    const screen = await renderScreen(<PromptFoldersScreen />);

    const rowActions = findTestInstanceByTypeWithProps(screen.tree, 'ItemRowActions', { title: 'Ops' });
    expect(rowActions).toBeDefined();
    const deleteAction = rowActions?.props.actions.find((action: any) => action.id === 'delete');
    expect(deleteAction).toBeDefined();

    await act(async () => {
      await deleteAction?.onPress();
    });

    expect(updatePromptDocMock).not.toHaveBeenCalled();
    expect(updateSkillPromptBundleMock).not.toHaveBeenCalled();
    expect(setPromptFoldersMock).toHaveBeenCalledWith({
      v: 1,
      folders: [],
    });
  });
});
