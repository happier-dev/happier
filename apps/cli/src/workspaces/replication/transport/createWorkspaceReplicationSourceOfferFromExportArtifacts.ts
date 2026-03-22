import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import type { WorkspaceReplicationDirectionScope } from '../relationships/relationshipScope';

import {
  createWorkspaceReplicationSourceOfferFromManifest,
  type WorkspaceReplicationSourceOffer,
} from './createWorkspaceReplicationSourceOffer';

function collectRequiredBlobDigests(
  manifest: ScmSourceControllerWorkspaceExportArtifacts['manifest'],
): readonly string[] {
  const digests = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.kind === 'file') {
      digests.add(entry.digest);
    }
  }
  return [...digests].sort((left, right) => left.localeCompare(right));
}

export async function createWorkspaceReplicationSourceOfferFromExportArtifacts(input: Readonly<{
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
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });
  const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-replication-export-artifacts-'));

  try {
    await mkdir(tempDirectory, { recursive: true });
    for (const digest of collectRequiredBlobDigests(input.workspaceExportArtifacts.manifest)) {
      const blobContent = input.workspaceExportArtifacts.blobContentsByDigest.get(digest);
      if (!blobContent) {
        throw new Error(`Missing workspace export blob for digest ${digest}`);
      }
      const temporaryBlobPath = join(tempDirectory, digest.replace(/[^a-zA-Z0-9_.-]/g, '_'));
      await writeFile(temporaryBlobPath, blobContent);
      await casStore.commitFile({
        digest,
        sourcePath: temporaryBlobPath,
      });
    }

    return await createWorkspaceReplicationSourceOfferFromManifest({
      activeServerDir: input.activeServerDir,
      source: input.source,
      target: input.target,
      mode: input.mode,
      ignorePatterns: input.ignorePatterns,
      manifest: input.workspaceExportArtifacts.manifest,
      ...(input.workspaceExportArtifacts.sourceControllerMetadata
        ? { sourceControllerMetadata: input.workspaceExportArtifacts.sourceControllerMetadata }
        : {}),
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
