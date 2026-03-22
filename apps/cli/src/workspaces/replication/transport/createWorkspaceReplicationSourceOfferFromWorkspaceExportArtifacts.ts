import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import type { WorkspaceManifestEntry } from '@/scm/sourceController/workspaceExportPackaging/buildWorkspaceManifestEntry';
import { fingerprintWorkspaceManifest } from '@/scm/sourceController/workspaceExportPackaging/fingerprintWorkspaceManifest';
import { objectKey } from '@/utils/deterministicJson';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import {
  buildWorkspaceReplicationDirectionId,
  createWorkspaceReplicationRelationshipStore,
} from '../relationships/workspaceReplicationRelationshipStore';
import type { WorkspaceReplicationDirectionScope } from '../relationships/relationshipScope';

import type { WorkspaceReplicationSourceOffer, WorkspaceReplicationSourceOfferBlob } from './createWorkspaceReplicationSourceOffer';

function compareManifestEntryPaths(left: WorkspaceManifestEntry, right: WorkspaceManifestEntry): number {
  if (left.relativePath < right.relativePath) {
    return -1;
  }
  if (left.relativePath > right.relativePath) {
    return 1;
  }
  return 0;
}

async function commitWorkspaceExportArtifactsToCas(input: Readonly<{
  activeServerDir: string;
  workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
}>): Promise<void> {
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-offer-artifacts-'));
  const committedDigests = new Set<string>();
  let blobIndex = 0;

  try {
    for (const entry of input.workspaceExportArtifacts.manifest.entries) {
      if (entry.kind !== 'file' || committedDigests.has(entry.digest)) {
        continue;
      }

      const blobContent = input.workspaceExportArtifacts.blobContentsByDigest.get(entry.digest);
      if (!blobContent) {
        throw new Error(`Missing workspace blob for replication source offer: ${entry.digest}`);
      }

      const sourcePath = join(tempRoot, `blob-${blobIndex}.bin`);
      blobIndex += 1;
      await writeFile(sourcePath, blobContent);
      await casStore.commitFile({
        digest: entry.digest,
        sourcePath,
      });
      committedDigests.add(entry.digest);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts(input: Readonly<{
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
  workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
}>): Promise<WorkspaceReplicationSourceOffer> {
  const scope: WorkspaceReplicationDirectionScope = {
    sourceMachineId: input.source.machineId,
    sourceWorkspaceRoot: input.source.rootPath,
    targetMachineId: input.target.machineId,
    targetWorkspaceRoot: input.target.rootPath,
    mode: input.mode,
    ...(input.ignorePatterns ? { ignorePatterns: input.ignorePatterns } : {}),
  };

  await commitWorkspaceExportArtifactsToCas({
    activeServerDir: input.activeServerDir,
    workspaceExportArtifacts: input.workspaceExportArtifacts,
  });

  const relationships = createWorkspaceReplicationRelationshipStore({
    activeServerDir: input.activeServerDir,
  });
  const relationship = await relationships.ensureRelationship(scope);
  const directionId = buildWorkspaceReplicationDirectionId(scope);
  const manifestEntries = [...input.workspaceExportArtifacts.manifest.entries].sort(compareManifestEntryPaths);
  const sourceFingerprint = fingerprintWorkspaceManifest({
    entries: manifestEntries,
  });
  const manifest: WorkspaceManifest = {
    entries: manifestEntries,
    fingerprint: sourceFingerprint,
  };
  const blobIndexByDigest = new Map<string, WorkspaceReplicationSourceOfferBlob>();

  for (const entry of manifest.entries) {
    if (entry.kind !== 'file' || blobIndexByDigest.has(entry.digest)) {
      continue;
    }
    blobIndexByDigest.set(entry.digest, {
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
    });
  }

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
    blobIndex: [...blobIndexByDigest.values()],
    ...(input.workspaceExportArtifacts.sourceControllerMetadata
      ? { sourceControllerMetadata: input.workspaceExportArtifacts.sourceControllerMetadata }
      : {}),
  };
}
