import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const promptModalMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const confirmModalMock = vi.hoisted(() => vi.fn(async () => true));
const updatePromptDocMock = vi.hoisted(() => vi.fn(async () => undefined));
const updateSkillPromptBundleMock = vi.hoisted(() => vi.fn(async () => undefined));
const setPromptFoldersMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('expo-router', () => ({
  Stack: { Screen: 'StackScreen' },
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) => factory({
      colors: {
        groupped: { background: '#fff' },
        accent: { blue: '#00f', indigo: '#60f' },
      },
    }),
  },
  useUnistyles: () => ({
    theme: {
      colors: {
        accent: { blue: '#00f', indigo: '#60f' },
      },
    },
  }),
}));

vi.mock('@/text', () => ({
  t: (key: string, params?: any) => {
    if (key === 'promptLibrary.folderUsageCount') return `${params?.count ?? 0} items`;
    return key;
  },
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

vi.mock('@/modal', () => ({
  Modal: {
    prompt: promptModalMock,
    confirm: confirmModalMock,
  },
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

vi.mock('@/sync/domains/state/storage', () => ({
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

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PromptFoldersScreen />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'promptFolders.add' }).props.onPress();
    });

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

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PromptFoldersScreen />);
    });

    const rowActions = tree.root.findByType('ItemRowActions');
    const deleteAction = rowActions.props.actions.find((action: any) => action.id === 'delete');

    await act(async () => {
      await deleteAction.onPress();
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
});
