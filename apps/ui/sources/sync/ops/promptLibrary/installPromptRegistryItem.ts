import {
  installPromptRegistryItemInLibrary,
  type PromptAssetMutationResponseV1,
  type PromptAssetInstallModeV1,
  type PromptAssetScopeV1,
  type PromptExternalLinksV1,
  type PromptRegistryConfiguredSourceV1,
  type PromptRegistryFetchedItemV1,
} from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';
import { machinePromptRegistriesDownloadItem, machinePromptRegistriesInstall } from '@/sync/ops/machinePromptRegistries';
import { defaultPromptAssetTargetInput } from '@/components/settings/prompts/assets/promptAssetExportDefaults';
import { uiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import { createPromptRegistrySkillArtifactFromFetchedItem } from './promptRegistrySkillImports';

export type PromptRegistryInstallResult = Readonly<
  | {
      ok: true;
      artifactId?: string;
      routeKind: 'bundle';
      exported: boolean;
      response?: Extract<PromptAssetMutationResponseV1, { ok: true }>;
      nextPromptExternalLinks?: PromptExternalLinksV1;
    }
  | {
      ok: false;
      error: string;
      artifactId?: string;
      errorCode?: string;
      currentDigest?: string | null;
    }
>;

export async function installPromptRegistryItem(args: Readonly<{
  machineId: string;
  serverId?: string | null;
  configuredSources: readonly PromptRegistryConfiguredSourceV1[];
  sourceId: string;
  itemId: string;
  installTarget?: Readonly<{
    assetTypeId: string;
    scope: PromptAssetScopeV1;
    directory?: string | null;
    targetName?: string | null;
    installMode?: PromptAssetInstallModeV1;
  }>;
  promptExternalLinks: PromptExternalLinksV1 | null | undefined;
  previewOnly?: boolean;
}>): Promise<PromptRegistryInstallResult> {
  let fetchedTitle = '';
  let fetchedItem: PromptRegistryFetchedItemV1 | null = null;
  const { installTarget, ...requestBase } = args;
  return await installPromptRegistryItemInLibrary({
    store: {
      ...uiPromptLibraryArtifactStore,
      create: async () => {
        if (!fetchedItem) throw new Error('prompt_registry_item_not_fetched');
        const imported = await createPromptRegistrySkillArtifactFromFetchedItem(fetchedItem);
        if (!imported.ok) throw new Error(imported.error);
        return imported.artifactId;
      },
    },
    fetchItem: async ({ machineId, serverId, sourceId, itemId, configuredSources }) => {
      const fetched = await machinePromptRegistriesDownloadItem(machineId, {
        sourceId,
        itemId,
        configuredSources: [...configuredSources],
      }, serverId ? { serverId } : undefined);
      if (fetched.ok) {
        fetchedTitle = fetched.item.title;
        fetchedItem = fetched.item;
        return fetched;
      }
      return { ok: false, errorCode: 'invalid_request', error: fetched.error };
    },
    install: async ({ machineId, serverId, request }) => await machinePromptRegistriesInstall(
      machineId,
      {
        ...request,
        installTarget: {
          ...request.installTarget,
          targetName: request.installTarget.targetName.trim() || defaultPromptAssetTargetInput({
            libraryKind: 'bundle',
            title: fetchedTitle,
          }),
        },
      },
      serverId ? { serverId } : undefined,
    ),
    request: {
      ...requestBase,
      ...(installTarget
        ? {
            installTarget: {
              assetTypeId: installTarget.assetTypeId,
              scope: installTarget.scope,
              ...(installTarget.directory ? { directory: installTarget.directory } : {}),
              ...(installTarget.installMode ? { installMode: installTarget.installMode } : {}),
              targetName: installTarget.targetName?.trim() ?? '',
            },
          }
        : {}),
    },
    randomId: randomUUID,
  });
}
