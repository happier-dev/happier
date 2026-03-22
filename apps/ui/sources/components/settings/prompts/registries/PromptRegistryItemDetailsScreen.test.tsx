import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptRegistryFetchItemResponseV1 } from '@happier-dev/protocol';
import { invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const modalAlertSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const machinePromptRegistriesDownloadItemMock = vi.hoisted(() => vi.fn<() => Promise<PromptRegistryFetchItemResponseV1>>(async () => ({
  ok: true,
  item: {
    sourceId: 'skills_sh:featured',
    itemId: 'skills_sh:featured:item-1',
    title: 'frontend-design',
    description: 'anthropics/skills',
    bundleSchemaId: 'skills.skill_md_v1',
    bundleBody: {
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Frontend design', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
        {
          path: 'templates/review.md',
          contentBase64: Buffer.from('review', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  },
})));
const createPromptRegistrySkillArtifactFromFetchedItemMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  artifactId: 'bundle-1',
})));
const installPromptRegistryItemMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  artifactId: 'bundle-2',
  routeKind: 'bundle' as const,
  exported: true,
  response: {
    ok: true as const,
    preview: {
      operation: 'write' as const,
      targetPath: '.agents/skills/frontend-design',
      fileCount: 2,
    },
  },
})));
const machinePromptAssetsListTypesMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  types: [
    {
      id: 'claude.user.skill',
      providerId: 'claude',
      title: 'Claude user skills',
      description: 'User-only skills',
      libraryKind: 'bundle',
      supportsScope: { user: true, project: false },
      supportsFiles: true,
      formatId: 'skill_md_v1',
      defaultRoots: [],
      capabilities: { supportsCatalogInstall: true },
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
      defaultRoots: [],
      capabilities: { supportsCatalogInstall: true, supportsSymlinkInstall: true },
    },
  ],
})));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            View: 'View',
                                            ScrollView: 'ScrollView',
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
        textSecondary: '#999',
        divider: '#ddd',
        input: { background: '#fff', text: '#111', placeholder: '#666' },
        accent: { indigo: '#60f', purple: '#90f', blue: '#00f' },
      },
    },
    });
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
});

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 1000 },
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
  TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/contextBar/ContextBar', () => ({
  ContextBar: (props: any) => React.createElement('ContextBar', props),
}));

vi.mock('@/components/contextBar/useContextBarSelection', () => ({
  useContextBarSelection: () => ({
    machineId: 'machine-1',
    setMachineId: vi.fn(),
    workspacePath: '/tmp/project',
    setWorkspacePath: vi.fn(),
  }),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/settingsSurface/SettingsActionFooter', () => ({
  SettingsActionFooter: (props: any) => React.createElement('SettingsActionFooter', props),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
  useHappyAction: (action: any) => [false, React.useCallback(() => {
    void action();
  }, [action])],
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
            confirm: modalConfirmSpy,
        },
    }).module;
});

vi.mock('@/sync/ops/machinePromptRegistries', () => ({
  machinePromptRegistriesDownloadItem: machinePromptRegistriesDownloadItemMock,
}));

vi.mock('@/sync/ops/machinePromptAssets', () => ({
  machinePromptAssetsListTypes: machinePromptAssetsListTypesMock,
}));

vi.mock('@/sync/ops/promptLibrary/promptRegistrySkillImports', () => ({
  createPromptRegistrySkillArtifactFromFetchedItem: createPromptRegistrySkillArtifactFromFetchedItemMock,
}));

vi.mock('@/sync/ops/promptLibrary/installPromptRegistryItem', () => ({
  installPromptRegistryItem: installPromptRegistryItemMock,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useAllMachines: () => [
    {
      id: 'machine-1',
      metadata: {
        displayName: 'Laptop',
        host: 'laptop.local',
      },
    },
  ],
    useSettingMutable: (key: string) => {
    if (key === 'promptRegistrySourcesV1') return [{ v: 1, sources: [] }, vi.fn()];
    if (key === 'promptExternalLinksV1') return [{ v: 1, links: [] }, vi.fn()];
    return [undefined, vi.fn()];
  },
});
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('PromptRegistryItemDetailsScreen', () => {
  beforeEach(() => {
    routerPushSpy.mockReset();
    modalAlertSpy.mockReset();
    modalConfirmSpy.mockReset();
    machinePromptRegistriesDownloadItemMock.mockClear();
    createPromptRegistrySkillArtifactFromFetchedItemMock.mockClear();
    installPromptRegistryItemMock.mockClear();
    machinePromptAssetsListTypesMock.mockClear();
  });

  it('loads registry item details and imports the fetched skill bundle into the library', async () => {
    const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
          machineId: 'machine-1',
          sourceId: 'skills_sh:featured',
          itemId: 'skills_sh:featured:item-1',
          configuredSources: [],
        }))).tree;
    await act(async () => {});

    expect(machinePromptRegistriesDownloadItemMock).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({
        sourceId: 'skills_sh:featured',
        itemId: 'skills_sh:featured:item-1',
      }),
    );

    const importRow = tree.findByTestId('promptRegistries.details.import');
    expect(importRow).toBeTruthy();

    await act(async () => {
      await pressTestInstanceAsync(importRow);
    });

    expect(createPromptRegistrySkillArtifactFromFetchedItemMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'frontend-design',
    }));
    expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/skills/bundle-1');
  });

  it('installs the fetched registry item to an external skill target', async () => {
    const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
          machineId: 'machine-1',
          sourceId: 'skills_sh:featured',
          itemId: 'skills_sh:featured:item-1',
          configuredSources: [],
          workspacePath: '/tmp/project',
        }))).tree;
    await act(async () => {});

    const footer = tree.findByType('SettingsActionFooter');

    await act(async () => {
      invokeTestInstanceHandler(await footer, 'onPrimaryPress', );
    });

    expect(installPromptRegistryItemMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      previewOnly: true,
      installTarget: expect.objectContaining({
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        installMode: 'symlink',
      }),
    }));
    expect(modalConfirmSpy).toHaveBeenCalledWith(
      'promptLibrary.registriesItemInstallConfirmTitle',
      '.agents/skills/frontend-design',
      { confirmText: 'promptLibrary.registriesItemInstallAction' },
    );
    expect(installPromptRegistryItemMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      previewOnly: false,
    }));
    expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/skills/bundle-2');
  });

  it('selects a scope-compatible install target before exporting', async () => {
    const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
          machineId: 'machine-1',
          sourceId: 'skills_sh:featured',
          itemId: 'skills_sh:featured:item-1',
          configuredSources: [],
          workspacePath: '/tmp/project',
        }))).tree;
    await act(async () => {});

    await act(async () => {
      invokeTestInstanceHandler(await tree.findByType('SettingsActionFooter'), 'onPrimaryPress', );
    });

    expect(installPromptRegistryItemMock).toHaveBeenCalledWith(expect.objectContaining({
      installTarget: expect.objectContaining({
        assetTypeId: 'agents.skill',
        scope: 'project',
      }),
    }));
  });
});
