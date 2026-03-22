import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmBackendRegistry } from '@/scm/registry';
import type { ScmSourceControllerWorkspaceTransferMetadata } from '@/scm/sourceController/workspaceTransfer';
import type { WorkspaceManifestEntry } from '@/scm/sourceController/workspaceExportPackaging/buildWorkspaceManifestEntry';
import { fingerprintWorkspaceManifest } from '@/scm/sourceController/workspaceExportPackaging/fingerprintWorkspaceManifest';
import type { WorkspaceManifestSafeFilterPolicy } from '@/scm/sourceController/workspaceExportPackaging/workspaceManifestSafeFilterPolicy';
import { objectKey } from '@/utils/deterministicJson';

import {
  buildWorkspaceReplicationDirectionId,
  createWorkspaceReplicationRelationshipStore,
} from '../relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationDirectionScope } from '../relationships/relationshipScope';
import { scanWorkspaceManifestIntoCas } from '../scan/scanWorkspaceManifestIntoCas';

export type WorkspaceReplicationSourceOfferBlob = Readonly<{
  digest: string;
  sizeBytes: number;
}>;

export type WorkspaceReplicationSourceOffer = Readonly<{
  offerId: string;
  relationshipId: string;
  directionId: string;
  sourceFingerprint: string;
  manifest: WorkspaceManifest;
  blobIndex: readonly WorkspaceReplicationSourceOfferBlob[];
  sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
}>;

function compareManifestEntryPaths(left: WorkspaceManifestEntry, right: WorkspaceManifestEntry): number {
  if (left.relativePath < right.relativePath) {
    return -1;
  }
  if (left.relativePath > right.relativePath) {
    return 1;
  }
  return 0;
}

function buildWorkspaceReplicationSourceOfferBlobIndex(
  manifest: WorkspaceManifest,
): readonly WorkspaceReplicationSourceOfferBlob[] {
  const blobIndexByDigest = new Map<string, WorkspaceReplicationSourceOfferBlob>();
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file') {
      continue;
    }
    if (blobIndexByDigest.has(entry.digest)) {
      continue;
    }
    blobIndexByDigest.set(entry.digest, {
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
    });
  }
  return [...blobIndexByDigest.values()];
}

export async function createWorkspaceReplicationSourceOfferFromManifest(input: Readonly<{
  activeServerDir: string;
  source: Readonly<{
    machineId: string;
    rootPath: string;
  }>;
  target: Readonly<{
    machineId: string;
    rootPath: string;
  }>;
  mode: WorkspaceReplicationDirectionScope['mode'];
  ignorePatterns?: readonly string[];
  manifest: WorkspaceManifest;
  sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
}>): Promise<WorkspaceReplicationSourceOffer> {
  const scope: WorkspaceReplicationDirectionScope = {
    sourceMachineId: input.source.machineId,
    sourceWorkspaceRoot: input.source.rootPath,
    targetMachineId: input.target.machineId,
    targetWorkspaceRoot: input.target.rootPath,
    mode: input.mode,
    ...(input.ignorePatterns ? { ignorePatterns: input.ignorePatterns } : {}),
  };

  const relationships = createWorkspaceReplicationRelationshipStore({
    activeServerDir: input.activeServerDir,
  });
  const relationship = await relationships.ensureRelationship(scope);
  const directionId = buildWorkspaceReplicationDirectionId(scope);
  const manifestEntries = [...input.manifest.entries].sort(compareManifestEntryPaths);
  const sourceFingerprint = fingerprintWorkspaceManifest({
    entries: manifestEntries,
  });
  const manifest: WorkspaceManifest = {
    entries: manifestEntries,
    fingerprint: sourceFingerprint,
  };

  return {
    offerId: `offer_${objectKey({
      relationshipId: relationship.relationshipId,
      directionId,
      sourceFingerprint,
    })}`,
    relationshipId: relationship.relationshipId,
    directionId,
    sourceFingerprint,
    manifest,
    blobIndex: buildWorkspaceReplicationSourceOfferBlobIndex(manifest),
    ...(input.sourceControllerMetadata ? { sourceControllerMetadata: input.sourceControllerMetadata } : {}),
  };
}

export async function createWorkspaceReplicationSourceOffer(input: Readonly<{
  activeServerDir: string;
  source: Readonly<{
    machineId: string;
    rootPath: string;
  }>;
  target: Readonly<{
    machineId: string;
    rootPath: string;
  }>;
  mode: WorkspaceReplicationDirectionScope['mode'];
  ignorePatterns?: readonly string[];
  safeFilterPolicy?: WorkspaceManifestSafeFilterPolicy;
  scmRegistry?: ScmBackendRegistry;
}>): Promise<WorkspaceReplicationSourceOffer> {
  const scope: WorkspaceReplicationDirectionScope = {
    sourceMachineId: input.source.machineId,
    sourceWorkspaceRoot: input.source.rootPath,
    targetMachineId: input.target.machineId,
    targetWorkspaceRoot: input.target.rootPath,
    mode: input.mode,
    ...(input.ignorePatterns ? { ignorePatterns: input.ignorePatterns } : {}),
  };
  const relationships = createWorkspaceReplicationRelationshipStore({
    activeServerDir: input.activeServerDir,
  });
  const relationship = await relationships.ensureRelationship(scope);
  const scannedManifest = await scanWorkspaceManifestIntoCas({
    activeServerDir: input.activeServerDir,
    relationshipId: relationship.relationshipId,
    workspaceRoot: input.source.rootPath,
    safeFilterPolicy: input.safeFilterPolicy,
    scmRegistry: input.scmRegistry,
  });
  return await createWorkspaceReplicationSourceOfferFromManifest({
    activeServerDir: input.activeServerDir,
    source: input.source,
    target: input.target,
    mode: input.mode,
    ignorePatterns: input.ignorePatterns,
    manifest: {
      entries: scannedManifest.entries.map((entry) => ({ ...entry })),
    },
  });
}
