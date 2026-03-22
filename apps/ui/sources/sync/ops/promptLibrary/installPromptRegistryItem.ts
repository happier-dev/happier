import {
  computePromptBundleDigestV1,
  type PromptAssetMutationResponseV1,
  type PromptAssetInstallModeV1,
  type PromptAssetScopeV1,
  type PromptExternalLinksV1,
  type PromptRegistryConfiguredSourceV1,
} from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';
import { machinePromptRegistriesDownloadItem, machinePromptRegistriesInstall } from '@/sync/ops/machinePromptRegistries';

import { defaultPromptAssetTargetInput } from '@/components/settings/prompts/assets/promptAssetExportDefaults';
import { createPromptRegistrySkillArtifactFromFetchedItem } from './promptRegistrySkillImports';
import { upsertPromptExternalLink } from './promptExternalLinks';

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
  const fetched = await machinePromptRegistriesDownloadItem(args.machineId, {
    sourceId: args.sourceId,
    itemId: args.itemId,
    configuredSources: [...args.configuredSources],
  }, args.serverId ? { serverId: args.serverId } : undefined);
  if (!fetched.ok) {
    return {
      ok: false,
      error: fetched.error,
    };
  }

  if (!args.installTarget) {
    const imported = await createPromptRegistrySkillArtifactFromFetchedItem(fetched.item);
    if (!imported.ok) {
      return imported;
    }
    return {
      ok: true,
      artifactId: imported.artifactId,
      routeKind: 'bundle',
      exported: false,
    };
  }

  const targetName = String(args.installTarget.targetName ?? '').trim() || defaultPromptAssetTargetInput({
    libraryKind: 'bundle',
    title: fetched.item.title,
  });
  const committed = await machinePromptRegistriesInstall(args.machineId, {
    sourceId: args.sourceId,
    itemId: args.itemId,
    configuredSources: [...args.configuredSources],
    installTarget: {
      assetTypeId: args.installTarget.assetTypeId,
      scope: args.installTarget.scope,
      ...(args.installTarget.scope === 'project'
        ? { directory: args.installTarget.directory ?? undefined }
        : {}),
      targetName,
      installMode: args.installTarget.installMode,
    },
    previewOnly: args.previewOnly,
  }, args.serverId ? { serverId: args.serverId } : undefined);

  if (!committed.ok || !committed.externalRef) {
    return {
      ok: false,
      error: committed.ok ? 'promptLibrary.saveError' : committed.error,
      ...(committed.ok
        ? {}
        : {
            errorCode: committed.errorCode,
            currentDigest: Object.prototype.hasOwnProperty.call(committed, 'currentDigest')
              ? (committed.currentDigest ?? null)
              : null,
          }),
    };
  }

  if (args.previewOnly === true) {
    return {
      ok: true,
      routeKind: 'bundle',
      exported: false,
      response: committed,
    };
  }

  const imported = await createPromptRegistrySkillArtifactFromFetchedItem(fetched.item);
  if (!imported.ok) {
    return imported;
  }

  return {
    ok: true,
    artifactId: imported.artifactId,
    routeKind: 'bundle',
    exported: true,
    response: committed,
    nextPromptExternalLinks: upsertPromptExternalLink(args.promptExternalLinks, {
      id: randomUUID(),
      artifactId: imported.artifactId,
      assetTypeId: args.installTarget.assetTypeId,
      scope: args.installTarget.scope,
      machineId: args.machineId,
      workspacePath: args.installTarget.scope === 'project'
        ? (args.installTarget.directory ?? null)
        : null,
      externalRef: committed.externalRef,
      syncMode: 'manual',
      baseDigest: committed.digest ?? null,
      lastLibraryDigest: computePromptBundleDigestV1(fetched.item.bundleBody),
      lastExternalDigest: committed.digest ?? null,
      lastSyncAtMs: Date.now(),
    }),
  };
}
