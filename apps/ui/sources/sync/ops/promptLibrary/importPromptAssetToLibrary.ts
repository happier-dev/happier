import { computePromptBundleDigestV1, computePromptDocDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import type { PromptAssetReadResponseV1 } from '@happier-dev/protocol/prompts/library/promptAssetsV1';
import type { PromptBundleSchemaIdV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { PromptExternalLinkEntryV1, PromptExternalLinksV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { createPromptDocInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

import { randomUUID } from '@/platform/randomUUID';

import { createPromptBundleArtifact } from './promptBundles';
import { upsertPromptExternalLink } from './promptDocs';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

type PromptAssetReadItem = Extract<PromptAssetReadResponseV1, { ok: true }>['item'];

function buildImportedPromptExternalLink(params: Readonly<{
  artifactId: string;
  item: PromptAssetReadItem;
  machineTarget: MachineAdministrationTargetV1;
  workspacePath?: string | null;
  nowMs?: number;
}>): PromptExternalLinkEntryV1 {
  return {
    id: randomUUID(),
    artifactId: params.artifactId,
    assetTypeId: params.item.assetTypeId,
    scope: params.item.scope,
    machineId: params.machineTarget.machineId,
    serverIdentityId: params.machineTarget.serverIdentityId,
    workspacePath: params.item.scope === 'project' ? (params.workspacePath ?? null) : null,
    externalRef: params.item.externalRef,
    syncMode: 'manual',
    baseDigest: params.item.digest,
    lastLibraryDigest: params.item.libraryKind === 'doc'
      ? computePromptDocDigestV1(params.item.markdown)
      : computePromptBundleDigestV1(params.item.bundleBody),
    lastExternalDigest: params.item.digest,
    lastSyncAtMs: params.nowMs ?? Date.now(),
  };
}

export async function importPromptAssetToLibrary(args: Readonly<{
  item: PromptAssetReadItem;
  machineTarget: MachineAdministrationTargetV1;
  libraryServerIdentityId: string;
  workspacePath?: string | null;
  promptExternalLinks: PromptExternalLinksV1 | null | undefined;
  nowMs?: number;
}>, store?: PromptLibraryArtifactStore): Promise<Readonly<{
  artifactId: string;
  routeKind: 'doc' | 'bundle';
  nextLinks: PromptExternalLinksV1;
}>> {
  const runImport = async (current: PromptLibraryArtifactStore) => {
    if (args.item.libraryKind === 'doc') {
      const { artifactId } = await createPromptDocInLibrary({ store: current, request: {
        title: args.item.title,
        markdown: args.item.markdown,
        origin: 'imported',
      } });
      return {
        artifactId,
        routeKind: 'doc' as const,
        nextLinks: upsertPromptExternalLink(args.promptExternalLinks, buildImportedPromptExternalLink({
          artifactId,
          item: args.item,
          machineTarget: args.machineTarget,
          workspacePath: args.workspacePath,
          nowMs: args.nowMs,
        }), { target: args.machineTarget, libraryServerIdentityId: args.libraryServerIdentityId }),
      };
    }

    const artifactId = await createPromptBundleArtifact({
      title: args.item.title,
      bundleSchemaId: args.item.bundleSchemaId as PromptBundleSchemaIdV1,
      entries: args.item.bundleBody.entries,
      origin: 'imported',
    }, current);
    return {
      artifactId,
      routeKind: 'bundle' as const,
      nextLinks: upsertPromptExternalLink(args.promptExternalLinks, buildImportedPromptExternalLink({
        artifactId,
        item: args.item,
        machineTarget: args.machineTarget,
        workspacePath: args.workspacePath,
        nowMs: args.nowMs,
      }), { target: args.machineTarget, libraryServerIdentityId: args.libraryServerIdentityId }),
    };
  };
  return store ? runImport(store) : withUiPromptLibraryArtifactStore(runImport);
}
