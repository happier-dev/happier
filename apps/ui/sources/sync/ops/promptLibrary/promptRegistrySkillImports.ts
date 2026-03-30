import type { PromptRegistryConfiguredSourceV1, PromptRegistryFetchedItemV1 } from '@happier-dev/protocol';

import { machinePromptRegistriesDownloadItem } from '@/sync/ops/machinePromptRegistries';

import { createPromptBundleArtifact } from './promptBundles';

export type PromptRegistrySkillImportResult = Readonly<
  | { ok: true; artifactId: string }
  | { ok: false; error: string }
>;

export async function createPromptRegistrySkillArtifactFromFetchedItem(
  item: PromptRegistryFetchedItemV1,
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
  });

  return {
    ok: true,
    artifactId,
  };
}

export async function importPromptRegistrySkillItem(args: Readonly<{
  machineId: string;
  configuredSources: PromptRegistryConfiguredSourceV1[];
  sourceId: string;
  itemId: string;
}>): Promise<PromptRegistrySkillImportResult> {
  const response = await machinePromptRegistriesDownloadItem(args.machineId, {
    sourceId: args.sourceId,
    itemId: args.itemId,
    configuredSources: args.configuredSources,
  });

  if (!response.ok) {
    return {
      ok: false,
      error: response.error,
    };
  }

  return await createPromptRegistrySkillArtifactFromFetchedItem(response.item);
}
