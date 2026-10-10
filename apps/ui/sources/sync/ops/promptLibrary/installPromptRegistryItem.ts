import { installPromptRegistryItemInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptAssetMutationResponseV1 } from '@happier-dev/protocol/prompts/library/promptAssetsV1';
import type { PromptAssetInstallModeV1, PromptAssetScopeV1 } from '@happier-dev/protocol/prompts/library/promptAssetDescriptorsV1';
import type { PromptExternalLinksV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import type { PromptRegistryConfiguredSourceV1, PromptRegistryFetchedItemV1 } from '@happier-dev/protocol/prompts/library/promptRegistriesV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { randomUUID } from '@/platform/randomUUID';
import { machinePromptRegistriesDownloadItem, machinePromptRegistriesInstall } from '@/sync/ops/machinePromptRegistries';
import { defaultPromptAssetTargetInput } from '@/components/settings/prompts/assets/promptAssetExportDefaults';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
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
      exported?: true;
      response?: Extract<PromptAssetMutationResponseV1, { ok: true }>;
    }
>;

export async function installPromptRegistryItem(args: Readonly<{
  machineId: string;
  machineTarget: MachineAdministrationTargetV1;
  libraryServerIdentityId: string;
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
  signal?: AbortSignal;
}>, store?: PromptLibraryArtifactStore): Promise<PromptRegistryInstallResult> {
  let fetchedTitle = '';
  let fetchedItem: PromptRegistryFetchedItemV1 | null = null;
  const { installTarget, machineTarget, libraryServerIdentityId, signal, ...requestBase } = args;
  const runInstall = (current: PromptLibraryArtifactStore) => installPromptRegistryItemInLibrary({
    machineTarget,
    libraryServerIdentityId,
    store: {
      ...current,
      create: async () => {
        if (!fetchedItem) throw new Error('prompt_registry_item_not_fetched');
        const imported = await createPromptRegistrySkillArtifactFromFetchedItem(fetchedItem, current);
        if (!imported.ok) throw new Error(imported.error);
        return imported.artifactId;
      },
    },
    fetchItem: async ({ machineId, serverId, sourceId, itemId, configuredSources, signal }) => {
      const fetched = await machinePromptRegistriesDownloadItem(machineId, {
        sourceId,
        itemId,
        configuredSources: [...configuredSources],
      }, serverId || signal ? { ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}) } : undefined);
      if (fetched.ok) {
        fetchedTitle = fetched.item.title;
        fetchedItem = fetched.item;
        return fetched;
      }
      return { ok: false, errorCode: 'invalid_request', error: fetched.error };
    },
    install: async ({ machineId, serverId, request, signal }) => await machinePromptRegistriesInstall(
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
      serverId || signal ? { ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}) } : undefined,
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
    ...(signal ? { signal } : {}),
  });
  return store ? runInstall(store) : withUiPromptLibraryArtifactStore(runInstall, { signal: args.signal });
}
