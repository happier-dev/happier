import type { WorkspaceManifest } from '@happier-dev/protocol';

import {
  compareWorkspaceManifests,
  type WorkspaceManifestComparison,
} from '@/scm/sourceController/workspaceExportPackaging/compareWorkspaceManifests';
import { fingerprintWorkspaceManifest } from '@/scm/sourceController/workspaceExportPackaging/fingerprintWorkspaceManifest';
import {
  createScmSourceControllerWorkspaceExportArtifacts,
  type ScmSourceControllerWorkspaceExportArtifacts,
} from '@/scm/sourceController/workspaceExportArtifacts';

export type SessionHandoffWorkspaceSyncArtifacts = Readonly<{
  currentManifest: WorkspaceManifest;
  nextManifest: WorkspaceManifest;
  comparison: WorkspaceManifestComparison;
  removedRelativePaths: readonly string[];
  changedWorkspaceArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
}>;

function cloneWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return {
    entries: manifest.entries.map((entry) => ({ ...entry })),
    ...(manifest.fingerprint ? { fingerprint: manifest.fingerprint } : {}),
  };
}

function collectChangedNextEntries(comparison: WorkspaceManifestComparison): WorkspaceManifest['entries'] {
  return [
    ...comparison.added,
    ...comparison.changed.map((entry) => entry.next),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function collectRequiredBlobDigests(entries: WorkspaceManifest['entries']): readonly string[] {
  const digests = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'file') {
      digests.add(entry.digest);
    }
  }
  return [...digests];
}

function createChangedWorkspaceArtifacts(params: Readonly<{
  changedEntries: WorkspaceManifest['entries'];
  sourceArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
}>): ScmSourceControllerWorkspaceExportArtifacts {
  const requiredBlobDigests = collectRequiredBlobDigests(params.changedEntries);
  const blobContentsByDigest = new Map<string, Uint8Array>();

  for (const digest of requiredBlobDigests) {
    const blobContent = params.sourceArtifacts.blobContentsByDigest.get(digest);
    if (!blobContent) {
      throw new Error(`Missing workspace blob for sync artifact: ${digest}`);
    }
    blobContentsByDigest.set(digest, blobContent);
  }

  const manifest: WorkspaceManifest = {
    entries: params.changedEntries.map((entry) => ({ ...entry })),
  };
  if (manifest.entries.length > 0) {
    manifest.fingerprint = fingerprintWorkspaceManifest({
      entries: manifest.entries,
    });
  }

  return createScmSourceControllerWorkspaceExportArtifacts({
    manifest,
    blobContentsByDigest,
    sourceControllerMetadata: params.sourceArtifacts.sourceControllerMetadata ?? null,
  });
}

export function createSessionHandoffWorkspaceSyncArtifacts(params: Readonly<{
  currentManifest: WorkspaceManifest;
  workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
}>): SessionHandoffWorkspaceSyncArtifacts {
  const currentManifest = cloneWorkspaceManifest(params.currentManifest);
  const nextManifest = cloneWorkspaceManifest(params.workspaceExportArtifacts.manifest);
  const comparison = compareWorkspaceManifests({
    previousManifest: currentManifest,
    nextManifest,
  });
  const changedEntries = collectChangedNextEntries(comparison);

  return {
    currentManifest,
    nextManifest,
    comparison,
    removedRelativePaths: comparison.removed.map((entry) => entry.relativePath),
    changedWorkspaceArtifacts: createChangedWorkspaceArtifacts({
      changedEntries,
      sourceArtifacts: params.workspaceExportArtifacts,
    }),
  };
}
