import {
  PromptBundleBodyV1Schema,
  PromptDocBodyV1Schema,
  computePromptBundleDigestV1,
  computePromptDocDigestV1,
  type PromptAssetInstallModeV1,
  type PromptAssetMutationResponseV1,
  type PromptAssetScopeV1,
  type PromptExternalLinksV1,
  type PromptBundleBodyV1,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { machinePromptAssetsWrite } from '@/sync/ops/machinePromptAssets';
import { randomUUID } from '@/platform/randomUUID';
import { findPromptExternalLink, upsertPromptExternalLink } from './promptDocs';

export type ExportablePromptLibraryArtifact =
  | Readonly<{ libraryKind: 'doc'; title: string; markdown: string }>
  | Readonly<{ libraryKind: 'bundle'; title: string; bundleBody: PromptBundleBodyV1 }>;

function resolveProjectDirectory(workspacePath: string | null | undefined): string | null {
  const trimmed = String(workspacePath ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function readPromptLibraryArtifactForExport(artifactId: string): Promise<ExportablePromptLibraryArtifact | null> {
  const local = storage.getState().artifacts[artifactId] ?? null;
  if (local?.body === undefined) {
    const full = await sync.fetchArtifactWithBody(artifactId);
    if (full) {
      storage.getState().updateArtifact(full);
    }
  }

  const artifact = storage.getState().artifacts[artifactId] ?? null;
  const title = typeof artifact?.header?.title === 'string' ? artifact.header.title : artifact?.title;
  const bodyText = typeof artifact?.body === 'string' ? artifact.body : null;
  if (!title || !bodyText) return null;

  try {
    const parsedBody = JSON.parse(bodyText);
    const promptDoc = PromptDocBodyV1Schema.safeParse(parsedBody);
    if (promptDoc.success) {
      return { libraryKind: 'doc', title, markdown: promptDoc.data.markdown };
    }

    const promptBundle = PromptBundleBodyV1Schema.safeParse(parsedBody);
    if (promptBundle.success) {
      return { libraryKind: 'bundle', title, bundleBody: promptBundle.data };
    }
  } catch {
    return null;
  }

  return null;
}

export async function writePromptLibraryArtifactToExternalAsset(args: Readonly<{
  artifactId: string;
  machineId: string;
  assetTypeId: string;
  scope: PromptAssetScopeV1;
  serverId?: string | null;
  workspacePath?: string | null;
  targetInput: string;
  installMode?: PromptAssetInstallModeV1;
  promptExternalLinks: PromptExternalLinksV1 | null | undefined;
  previewOnly: boolean;
}>): Promise<
  | Readonly<{ ok: false; error: string; errorCode?: string; currentDigest?: string | null }>
  | Readonly<{
      ok: true;
      artifactState: ExportablePromptLibraryArtifact;
      response: Extract<PromptAssetMutationResponseV1, { ok: true }>;
      nextPromptExternalLinks?: PromptExternalLinksV1;
    }>
> {
  const artifactState = await readPromptLibraryArtifactForExport(args.artifactId);
  if (!artifactState) {
    return { ok: false, error: 'promptLibrary.saveError' };
  }

  const directory = args.scope === 'project'
    ? resolveProjectDirectory(args.workspacePath)
    : null;
  if (args.scope === 'project' && !directory) {
    return { ok: false, error: 'promptLibrary.externalAssetsProjectDirectoryRequired' };
  }

  const currentLink = findPromptExternalLink(args.promptExternalLinks, {
    artifactId: args.artifactId,
    assetTypeId: args.assetTypeId,
    machineId: args.machineId,
    scope: args.scope,
    workspacePath: directory,
  });

  const expectedDigest = currentLink?.lastExternalDigest ?? null;
  const request = artifactState.libraryKind === 'doc'
    ? {
        assetTypeId: args.assetTypeId,
        scope: args.scope,
        ...(directory ? { directory } : {}),
        externalRef: currentLink?.externalRef ?? null,
        targetPath: args.targetInput.trim(),
        title: artifactState.title,
        markdown: artifactState.markdown,
        previewOnly: args.previewOnly,
        expectedDigest,
      }
    : {
        assetTypeId: args.assetTypeId,
        scope: args.scope,
        ...(directory ? { directory } : {}),
        externalRef: currentLink?.externalRef ?? null,
        targetName: args.targetInput.trim(),
        title: artifactState.title,
        bundleSchemaId: 'skills.skill_md_v1' as const,
        bundleBody: artifactState.bundleBody,
        installMode: args.installMode,
        previewOnly: args.previewOnly,
        expectedDigest,
      };

  const response = await machinePromptAssetsWrite(
    args.machineId,
    request,
    args.serverId ? { serverId: args.serverId } : undefined,
  );
  if (!response.ok) {
    return {
      ok: false,
      error: response.error,
      ...(typeof response.errorCode === 'string' ? { errorCode: response.errorCode } : {}),
      ...(Object.prototype.hasOwnProperty.call(response, 'currentDigest') ? { currentDigest: response.currentDigest ?? null } : {}),
    };
  }

  if (args.previewOnly) {
    return { ok: true, artifactState, response };
  }

  if (!response.externalRef) {
    return { ok: false, error: 'promptLibrary.saveError' };
  }

  const nextPromptExternalLinks = upsertPromptExternalLink(args.promptExternalLinks, {
    id: currentLink?.id ?? randomUUID(),
    artifactId: args.artifactId,
    assetTypeId: args.assetTypeId,
    scope: args.scope,
    machineId: args.machineId,
    workspacePath: args.scope === 'project' ? directory : null,
    externalRef: response.externalRef,
    syncMode: currentLink?.syncMode ?? 'manual',
    baseDigest: currentLink?.baseDigest ?? response.digest ?? null,
    lastLibraryDigest: artifactState.libraryKind === 'doc'
      ? computePromptDocDigestV1(artifactState.markdown)
      : computePromptBundleDigestV1(artifactState.bundleBody),
    lastExternalDigest: response.digest ?? null,
    lastSyncAtMs: Date.now(),
  });

  return {
    ok: true,
    artifactState,
    response,
    nextPromptExternalLinks,
  };
}
