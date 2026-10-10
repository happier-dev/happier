import type { PromptRegistryConfiguredSourceV1, PromptRegistryFetchedItemV1 } from '@happier-dev/protocol';
import type { PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

import { machinePromptRegistriesDownloadItem } from '@/sync/ops/machinePromptRegistries';

import { createPromptBundleArtifact } from './promptBundles';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

export type PromptRegistrySkillImportResult = Readonly<
  | { ok: true; artifactId: string }
  | { ok: false; error: string }
>;

export async function createPromptRegistrySkillArtifactFromFetchedItem(
  item: PromptRegistryFetchedItemV1,
  store?: PromptLibraryArtifactStore,
): Promise<PromptRegistrySkillImportResult> {
  if (item.bundleSchemaId !== 'skills.skill_md_v1') {
    return {
      ok: false,
      error: 'promptLibrary.externalAssetsUnsupportedImport',
    };
  }

  const artifactId = await createPromptBundleArtifact({
    title: item.title,
    bundleSchemaId: item.bundleSchemaId,
    entries: item.bundleBody.entries,
    origin: 'imported',
  }, store);

  return {
    ok: true,
    artifactId,
  };
}

export async function importPromptRegistrySkillItem(args: Readonly<{
  machineId: string;
  serverId?: string | null;
  configuredSources: PromptRegistryConfiguredSourceV1[];
  sourceId: string;
  itemId: string;
  signal?: AbortSignal;
}>, store?: PromptLibraryArtifactStore): Promise<PromptRegistrySkillImportResult> {
  const runImport = async (current: PromptLibraryArtifactStore): Promise<PromptRegistrySkillImportResult> => {
    args.signal?.throwIfAborted();
    const response = await machinePromptRegistriesDownloadItem(args.machineId, {
      sourceId: args.sourceId,
      itemId: args.itemId,
      configuredSources: args.configuredSources,
    }, { serverId: args.serverId, signal: args.signal });
    args.signal?.throwIfAborted();

    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
      };
    }

    return await createPromptRegistrySkillArtifactFromFetchedItem(response.item, current);
  };
  // Machine placement is independent of the captured library Account/Home.
  return store ? runImport(store) : withUiPromptLibraryArtifactStore(runImport, { signal: args.signal });
}
