import {
  computePromptBundleDigestV1,
  computePromptDocDigestV1,
  type PromptAssetReadResponseV1,
  type PromptBundleSchemaIdV1,
  type PromptExternalLinkEntryV1,
  type PromptExternalLinksV1,
} from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';

import { createPromptBundleArtifact } from './promptBundles';
import { createPromptDoc, upsertPromptExternalLink } from './promptDocs';

type PromptAssetReadItem = Extract<PromptAssetReadResponseV1, { ok: true }>['item'];

function buildImportedPromptExternalLink(params: Readonly<{
  artifactId: string;
  item: PromptAssetReadItem;
  machineId: string;
  workspacePath?: string | null;
  nowMs?: number;
}>): PromptExternalLinkEntryV1 {
  return {
    id: randomUUID(),
    artifactId: params.artifactId,
    assetTypeId: params.item.assetTypeId,
    scope: params.item.scope,
    machineId: params.machineId,
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
  machineId: string;
  workspacePath?: string | null;
  promptExternalLinks: PromptExternalLinksV1 | null | undefined;
  nowMs?: number;
}>): Promise<Readonly<{
  artifactId: string;
  routeKind: 'doc' | 'bundle';
  nextLinks: PromptExternalLinksV1;
}>> {
  if (args.item.libraryKind === 'doc') {
    const artifactId = await createPromptDoc({
      title: args.item.title,
      markdown: args.item.markdown,
      origin: 'imported',
    });
    return {
      artifactId,
      routeKind: 'doc',
      nextLinks: upsertPromptExternalLink(args.promptExternalLinks, buildImportedPromptExternalLink({
        artifactId,
        item: args.item,
        machineId: args.machineId,
        workspacePath: args.workspacePath,
        nowMs: args.nowMs,
      })),
    };
  }

    const artifactId = await createPromptBundleArtifact({
      title: args.item.title,
      bundleSchemaId: args.item.bundleSchemaId as PromptBundleSchemaIdV1,
      entries: args.item.bundleBody.entries,
      origin: 'imported',
    });
  return {
    artifactId,
    routeKind: 'bundle',
    nextLinks: upsertPromptExternalLink(args.promptExternalLinks, buildImportedPromptExternalLink({
      artifactId,
      item: args.item,
      machineId: args.machineId,
      workspacePath: args.workspacePath,
      nowMs: args.nowMs,
    })),
  };
}
