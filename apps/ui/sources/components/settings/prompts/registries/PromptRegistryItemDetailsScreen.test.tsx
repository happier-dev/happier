import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptRegistryFetchItemResponseV1 } from '@happier-dev/protocol';
import { invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
  installPromptRegistriesCommonModuleMocks,
  promptRegistriesRouterPushSpy,
} from './promptRegistriesScreenTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
const administrationTargetState = vi.hoisted(() => ({
  current: {
    target: { serverIdentityId: 'identity-1', machineId: 'machine-1' },
    serverId: 'server-1',
    machine: {
      id: 'machine-1',
      metadata: {
        displayName: 'Laptop',
        host: 'laptop.local',
      },
    },
  } as {
    target: { serverIdentityId: string; machineId: string };
    serverId: string;
    machine: { id: string; metadata: { displayName: string; host: string } };
  } | null,
}));
installPromptRegistriesCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlertSpy,
        confirm: modalConfirmSpy,
      },
    }).module;
  },
  storage: async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
      useSettingMutable: (key: string) => {
        if (key === 'promptRegistrySourcesV1') return [{ v: 1, sources: [] }, vi.fn()];
        if (key === 'promptExternalLinksV1') return [{ v: 1, links: [] }, vi.fn()];
        return [undefined, vi.fn()];
      },
    });
  },
  unistyles: async () => {
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
  },
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 1000 },
  useLayoutMaxWidth: () => 1000,
  useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
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

vi.mock('@/components/settings/contextBar/ContextBar', () => ({
  ContextBar: (props: any) => React.createElement('ContextBar', props),
}));

vi.mock('@/components/settings/contextBar/useContextBarSelection', () => ({
  useContextBarSelection: () => ({
    workspacePath: '/tmp/project',
    setWorkspacePath: vi.fn(),
  }),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
  MachineAdministrationTargetSelector: (props: any) => React.createElement('MachineAdministrationTargetSelector', props),
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
  useMachineAdministrationTargetSelection: () => ({
    selectedTarget: administrationTargetState.current?.target ?? null,
    canExecute: administrationTargetState.current !== null,
    resolveExecutionTarget: () => administrationTargetState.current,
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

describe('PromptRegistryItemDetailsScreen', () => {
  beforeEach(() => {
    promptRegistriesRouterPushSpy.mockReset();
    modalAlertSpy.mockReset();
    modalConfirmSpy.mockReset();
    machinePromptRegistriesDownloadItemMock.mockClear();
    createPromptRegistrySkillArtifactFromFetchedItemMock.mockClear();
    installPromptRegistryItemMock.mockClear();
    machinePromptAssetsListTypesMock.mockClear();
    administrationTargetState.current = {
      target: { serverIdentityId: 'identity-1', machineId: 'machine-1' },
      serverId: 'server-1',
      machine: {
        id: 'machine-1',
        metadata: {
          displayName: 'Laptop',
          host: 'laptop.local',
        },
      },
    };
  });

  it('renders the utf8 bundle preview without depending on Buffer.from at runtime (web)', async () => {
    const originalBufferFrom = Buffer.from;
    Buffer.from = ((...args: any[]) => {
      const stack = new Error().stack ?? '';
      if (stack.includes('decodeUtf8BundleEntry')) {
        throw new Error('Buffer.from should not be used for web preview decoding');
      }
      return originalBufferFrom(...(args as [any]));
    }) as any;

    try {
      const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

      const tree = (await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
        sourceId: 'skills_sh:featured',
        itemId: 'skills_sh:featured:item-1',
        configuredSources: [],
      }))).tree;
      await act(async () => {});

      const previewNodes = tree.root.findAll((node) =>
        typeof node.props.children === 'string'
        && node.props.children.includes('# Frontend design')
      );
      expect(previewNodes.length).toBeGreaterThan(0);
    } finally {
      Buffer.from = originalBufferFrom;
    }
  });

  it('loads registry item details and imports the fetched skill bundle into the library', async () => {
    const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
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
      { serverId: 'server-1' },
    );

    const importRow = tree.findByTestId('promptRegistries.details.import');
    expect(importRow).toBeTruthy();

    await act(async () => {
      await pressTestInstanceAsync(importRow);
    });

    expect(createPromptRegistrySkillArtifactFromFetchedItemMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'frontend-design',
    }));
    expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/skills/bundle-1');
  });

  it('installs the fetched registry item to an external skill target', async () => {
    const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
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
      serverId: 'server-1',
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
      machineId: 'machine-1',
      serverId: 'server-1',
      previewOnly: false,
    }));
    expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/skills/bundle-2');
  });

  it('selects a scope-compatible install target before exporting', async () => {
    const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
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

  it('does not use the route machine id when no fresh Administration target is available', async () => {
    administrationTargetState.current = null;
    const { PromptRegistryItemDetailsScreen } = await import('./PromptRegistryItemDetailsScreen');

    await renderScreen(React.createElement(PromptRegistryItemDetailsScreen, {
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
    }));
    await act(async () => {});

    expect(machinePromptRegistriesDownloadItemMock).not.toHaveBeenCalled();
    expect(machinePromptAssetsListTypesMock).not.toHaveBeenCalled();
    expect(installPromptRegistryItemMock).not.toHaveBeenCalled();
  });
});
