import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setPromptExternalLinksMock = vi.hoisted(() => vi.fn());
const setContextSelectionsMock = vi.hoisted(() => vi.fn());
const machinePromptAssetsListTypesMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  types: [
    {
      id: 'claude.user.command',
      providerId: 'claude',
      title: 'Claude user commands (.claude)',
      description: 'User markdown slash commands',
      libraryKind: 'doc',
      supportsScope: { user: true, project: false },
      supportsFiles: false,
      formatId: 'markdown_utf8_v1',
      defaultRoots: [
        { label: 'User commands', scope: 'user', pathTemplate: '~/.claude/commands' },
      ],
      capabilities: { supportsNestedNamespaces: true },
    },
    {
      id: 'agents.skill',
      providerId: 'agents',
      title: 'Agent skills (.agents)',
      description: 'Portable agent skills',
      libraryKind: 'bundle',
      supportsScope: { user: true, project: true },
      supportsFiles: true,
      formatId: 'skill_md_v1',
      defaultRoots: [
        { label: 'Project skills', scope: 'project', pathTemplate: '.agents/skills' },
        { label: 'User skills', scope: 'user', pathTemplate: '~/.agents/skills' },
      ],
      capabilities: { supportsCatalogInstall: true, supportsSymlinkInstall: true },
    },
    {
      id: 'claude.command',
      providerId: 'claude',
      title: 'Claude commands (.claude)',
      description: 'Markdown slash commands',
      libraryKind: 'doc',
      supportsScope: { user: true, project: true },
      supportsFiles: false,
      formatId: 'markdown_utf8_v1',
      defaultRoots: [
        { label: 'Project commands', scope: 'project', pathTemplate: '.claude/commands' },
        { label: 'User commands', scope: 'user', pathTemplate: '~/.claude/commands' },
      ],
      capabilities: { supportsNestedNamespaces: true },
    },
  ],
})));
const machinePromptAssetsWriteMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  externalRef: { relativePath: 'review/code.md' },
  digest: 'sha256:new',
  preview: {
    operation: 'write',
    targetPath: '.claude/commands/review/code.md',
    fileCount: 1,
  },
})));
const machinePromptAssetsDeleteMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  externalRef: { relativePath: 'review/code.md' },
  digest: 'sha256:new',
  preview: {
    operation: 'delete',
    targetPath: '.claude/commands/review/code.md',
    fileCount: 1,
  },
})));
const readPromptLibraryArtifactForExportMock = vi.hoisted(() => vi.fn(async (artifactId: string) => {
  if (artifactId === 'broken-1') return null;
  if (artifactId === 'bundle-1') {
    return {
      libraryKind: 'bundle' as const,
      title: 'reviewer',
      bundleBody: {
        v: 1,
        entries: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('# Reviewer\n', 'utf8').toString('base64'),
            contentKind: 'utf8' as const,
          },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    };
  }
  return {
    libraryKind: 'doc' as const,
    title: 'review/code',
    markdown: '# Review code\n\nUse $ARGUMENTS',
  };
}));
const writePromptLibraryArtifactToExternalAssetMock = vi.hoisted(() => vi.fn(async (args: any) => {
  if (args.previewOnly) {
    return {
      ok: true as const,
      artifactState: {
        libraryKind: 'doc' as const,
        title: 'review/code',
        markdown: '# Review code\n\nUse $ARGUMENTS',
      },
      response: {
        ok: true as const,
        preview: {
          operation: 'write',
          targetPath: '.claude/commands/review/code.md',
          fileCount: 1,
        },
      },
    };
  }
  return {
    ok: true as const,
    artifactState: {
      libraryKind: 'doc' as const,
      title: 'review/code',
      markdown: '# Review code\n\nUse $ARGUMENTS',
    },
    response: {
      ok: true as const,
      externalRef: { relativePath: 'review/code.md' },
      digest: 'sha256:new',
    },
    nextPromptExternalLinks: {
      v: 1,
      links: [
        {
          id: 'link-1',
          artifactId: args.artifactId,
          assetTypeId: args.assetTypeId,
          scope: args.scope,
          machineId: args.machineId,
          workspacePath: args.scope === 'project' ? args.workspacePath : null,
          externalRef: { relativePath: 'review/code.md' },
          syncMode: 'manual',
          baseDigest: 'sha256:new',
          lastLibraryDigest: 'sha256:lib',
          lastExternalDigest: 'sha256:new',
          lastSyncAtMs: 123,
        },
      ],
    },
  };
}));

const promptExternalLinksState = vi.hoisted(() => ({
  value: {
    v: 1,
    links: [] as Array<Record<string, unknown>>,
  },
}));

const contextSelectionsState = vi.hoisted(() => ({
  value: { v: 1, selectionsByKey: {} as Record<string, { machineId?: string | null; workspacePath?: string | null }> },
}));

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  Platform: { OS: 'web', select: ({ web, default: defaultValue }: any) => web ?? defaultValue },
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) => factory({
      colors: {
        groupped: { background: '#fff' },
        textSecondary: '#999',
        divider: '#ddd',
        input: { background: '#fff', text: '#111', placeholder: '#666' },
        accent: { blue: '#00f', indigo: '#60f', purple: '#90f' },
        deleteAction: '#f33',
        button: { primary: { tint: '#fff' } },
      },
    }),
  },
  useUnistyles: () => ({
    theme: {
      colors: {
        textSecondary: '#999',
        input: { placeholder: '#666' },
        accent: { blue: '#00f', indigo: '#60f', purple: '#90f' },
        deleteAction: '#f33',
        button: { primary: { tint: '#fff' } },
      },
    },
  }),
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 960 },
}));

vi.mock('@/components/contextBar/ContextBar', () => ({
  ContextBar: (props: any) => React.createElement('ContextBar', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
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

vi.mock('@/components/ui/settingsSurface/SettingsActionFooter', () => ({
  SettingsActionFooter: (props: any) => React.createElement('SettingsActionFooter', props),
}));

vi.mock('@/modal', () => ({
  Modal: {
    alert: vi.fn(),
    confirm: vi.fn(async () => true),
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useAllMachines: () => [
    {
      id: 'machine-1',
      metadata: {
        displayName: 'Laptop',
        host: 'laptop.local',
        homeDir: '/Users/test',
      },
    },
  ],
  useSettingMutable: (key: string) => {
    if (key === 'promptExternalLinksV1') {
      return [promptExternalLinksState.value, setPromptExternalLinksMock];
    }
    if (key === 'contextSelectionsV1') {
      return [contextSelectionsState.value, setContextSelectionsMock];
    }
    return [null, vi.fn()];
  },
  storage: {
    getState: () => ({
      artifacts: {
        'doc-1': {
          id: 'doc-1',
          header: { title: 'review/code', kind: 'prompt_doc.v2' },
          body: JSON.stringify({
            v: 1,
            markdown: '# Review code\n\nUse $ARGUMENTS',
            createdAtMs: 1,
            updatedAtMs: 2,
          }),
        },
        'bundle-1': {
          id: 'bundle-1',
          header: { title: 'reviewer', kind: 'prompt_bundle.v2' },
          body: JSON.stringify({
            v: 1,
            entries: [
              {
                path: 'SKILL.md',
                contentBase64: Buffer.from('# Reviewer\n', 'utf8').toString('base64'),
                contentKind: 'utf8',
              },
            ],
            createdAtMs: 1,
            updatedAtMs: 2,
          }),
        },
        'broken-1': {
          id: 'broken-1',
          header: { title: 'broken artifact', kind: 'prompt_doc.v2' },
          body: '{not-json',
        },
      },
      updateArtifact: vi.fn(),
    }),
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    getCredentials: () => ({ ok: true }),
    fetchArtifactWithBody: vi.fn(async () => null),
  },
}));

vi.mock('@/sync/ops/machinePromptAssets', () => ({
  machinePromptAssetsListTypes: machinePromptAssetsListTypesMock,
  machinePromptAssetsWrite: machinePromptAssetsWriteMock,
  machinePromptAssetsDelete: machinePromptAssetsDeleteMock,
}));

vi.mock('@/sync/ops/promptLibrary/exportPromptLibraryArtifact', () => ({
  readPromptLibraryArtifactForExport: readPromptLibraryArtifactForExportMock,
  writePromptLibraryArtifactToExternalAsset: writePromptLibraryArtifactToExternalAssetMock,
}));

describe('PromptAssetExportScreen', () => {
  beforeEach(() => {
    machinePromptAssetsListTypesMock.mockClear();
    machinePromptAssetsWriteMock.mockClear();
    machinePromptAssetsDeleteMock.mockClear();
    readPromptLibraryArtifactForExportMock.mockClear();
    writePromptLibraryArtifactToExternalAssetMock.mockClear();
    setPromptExternalLinksMock.mockReset();
    setContextSelectionsMock.mockReset();
    promptExternalLinksState.value = { v: 1, links: [] };
    contextSelectionsState.value = { v: 1, selectionsByKey: {} };
  });

  it('exports a prompt doc to a compatible external markdown asset and stores the link', async () => {
    contextSelectionsState.value = {
      v: 1,
      selectionsByKey: {
        'promptAssets.export.doc-1': {
          machineId: 'machine-1',
          workspacePath: '/Users/test/repo',
        },
      },
    };

    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'doc-1' }));
      await Promise.resolve();
    });

    const footer = tree.root.findByType('SettingsActionFooter');
    await act(async () => {
      await footer.props.onPrimaryPress();
    });

    expect(writePromptLibraryArtifactToExternalAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'project',
      targetInput: 'review/code.md',
    }));
    expect(setPromptExternalLinksMock).toHaveBeenCalledWith({
      v: 1,
      links: [
        expect.objectContaining({
          artifactId: 'doc-1',
          assetTypeId: 'claude.command',
          machineId: 'machine-1',
          externalRef: { relativePath: 'review/code.md' },
          syncMode: 'manual',
          baseDigest: 'sha256:new',
          lastLibraryDigest: 'sha256:lib',
          lastExternalDigest: 'sha256:new',
          lastSyncAtMs: 123,
        }),
      ],
    });
  });

  it('selects a scope-compatible asset type before exporting', async () => {
    contextSelectionsState.value = {
      v: 1,
      selectionsByKey: {
        'promptAssets.export.doc-1': {
          machineId: 'machine-1',
          workspacePath: '/Users/test/repo',
        },
      },
    };

    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'doc-1' }));
      await Promise.resolve();
    });

    await act(async () => {
      await tree.root.findByType('SettingsActionFooter').props.onPrimaryPress();
    });

    expect(writePromptLibraryArtifactToExternalAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      assetTypeId: 'claude.command',
      scope: 'project',
    }));
  });

  it('defaults bundle exports to symlink installs when the selected asset type supports them', async () => {
    contextSelectionsState.value = {
      v: 1,
      selectionsByKey: {
        'promptAssets.export.bundle-1': {
          machineId: 'machine-1',
          workspacePath: '/Users/test/repo',
        },
      },
    };

    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'bundle-1' }));
      await Promise.resolve();
    });

    await act(async () => {
      await tree.root.findByType('SettingsActionFooter').props.onPrimaryPress();
    });

    expect(writePromptLibraryArtifactToExternalAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'bundle-1',
      assetTypeId: 'agents.skill',
      scope: 'project',
      installMode: 'symlink',
    }));
  });

  it('reads the prompt artifact once during initial load', async () => {
    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    await act(async () => {
      renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'doc-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readPromptLibraryArtifactForExportMock).toHaveBeenCalledTimes(1);
  });

  it('passes machine browse config to the export workspace context bar input', async () => {
    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'doc-1' }));
      await Promise.resolve();
    });

    const contextBar = tree.root.findByType('ContextBar');
    expect(contextBar.props.workspace.browse).toEqual({
      machineId: 'machine-1',
      enabled: true,
    });
  });

  it('deletes a stored external link target and removes the persisted link', async () => {
    contextSelectionsState.value = {
      v: 1,
      selectionsByKey: {
        'promptAssets.export.doc-1': {
          machineId: 'machine-1',
          workspacePath: '/Users/test/repo',
        },
      },
    };
    promptExternalLinksState.value = {
      v: 1,
      links: [
        {
          id: 'link-1',
          artifactId: 'doc-1',
          assetTypeId: 'claude.command',
          scope: 'project',
          machineId: 'machine-1',
          workspacePath: '/Users/test/repo',
          externalRef: { relativePath: 'review/code.md' },
          lastExternalDigest: 'sha256:new',
        },
      ],
    };

    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'doc-1' }));
      await Promise.resolve();
    });

    const footer = tree.root.findByType('SettingsActionFooter');
    await act(async () => {
      await footer.props.onSecondaryPress();
    });

    expect(machinePromptAssetsDeleteMock).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({
        assetTypeId: 'claude.command',
        externalRef: { relativePath: 'review/code.md' },
      }),
      undefined,
    );
    expect(setPromptExternalLinksMock).toHaveBeenCalledWith({
      v: 1,
      links: [],
    });
  });

  it('does not surface a project-scope delete action when the workspace input is blank', async () => {
    contextSelectionsState.value = {
      v: 1,
      selectionsByKey: {
        'promptAssets.export.doc-1': {
          machineId: 'machine-1',
          workspacePath: '',
        },
      },
    };
    promptExternalLinksState.value = {
      v: 1,
      links: [
        {
          id: 'link-1',
          artifactId: 'doc-1',
          assetTypeId: 'claude.command',
          scope: 'project',
          machineId: 'machine-1',
          workspacePath: '/Users/test/repo',
          externalRef: { relativePath: 'review/code.md' },
          lastExternalDigest: 'sha256:new',
        },
      ],
    };

    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'doc-1' }));
      await Promise.resolve();
    });

    expect(tree.root.findByType('SettingsActionFooter').props.secondaryTestID).toBeUndefined();
  });

  it('does not export a project-scoped prompt asset until a workspace path is selected', async () => {
    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'doc-1' }));
      await Promise.resolve();
    });

    await act(async () => {
      await tree.root.findByType('SettingsActionFooter').props.onPrimaryPress();
    });

    expect(machinePromptAssetsWriteMock).not.toHaveBeenCalled();
  });

  it('does not crash when the artifact body is malformed json', async () => {
    const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(PromptAssetExportScreen, { artifactId: 'broken-1' }));
      await Promise.resolve();
    });

    const footer = tree.root.findByType('SettingsActionFooter');
    expect(footer.props.primaryDisabled).toBe(true);
    expect(writePromptLibraryArtifactToExternalAssetMock).not.toHaveBeenCalled();
  });

});
