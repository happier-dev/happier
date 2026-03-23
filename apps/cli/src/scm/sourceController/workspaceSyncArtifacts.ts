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

export type WorkspaceSyncArtifacts = Readonly<{
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

function createChangedWorkspaceManifest(changedEntries: WorkspaceManifest['entries']): WorkspaceManifest {
    const manifest: WorkspaceManifest = {
        entries: changedEntries.map((entry) => ({ ...entry })),
    };
    if (manifest.entries.length > 0) {
        manifest.fingerprint = fingerprintWorkspaceManifest({
            entries: manifest.entries,
        });
    }
    return manifest;
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

    return createScmSourceControllerWorkspaceExportArtifacts({
        manifest: createChangedWorkspaceManifest(params.changedEntries),
        blobContentsByDigest,
        sourceControllerMetadata: params.sourceArtifacts.sourceControllerMetadata ?? null,
    });
}

function createWorkspaceSyncArtifactsCore(params: Readonly<{
    currentManifest: WorkspaceManifest;
    nextManifest: WorkspaceManifest;
}>): Readonly<{
    currentManifest: WorkspaceManifest;
    nextManifest: WorkspaceManifest;
    comparison: WorkspaceManifestComparison;
    changedEntries: WorkspaceManifest['entries'];
}> {
    const currentManifest = cloneWorkspaceManifest(params.currentManifest);
    const nextManifest = cloneWorkspaceManifest(params.nextManifest);
    const comparison = compareWorkspaceManifests({
        previousManifest: currentManifest,
        nextManifest,
    });
    const changedEntries = collectChangedNextEntries(comparison);

    return {
        currentManifest,
        nextManifest,
        comparison,
        changedEntries,
    };
}

export function createWorkspaceSyncArtifactsFromManifest(params: Readonly<{
    currentManifest: WorkspaceManifest;
    nextManifest: WorkspaceManifest;
    sourceControllerMetadata?: ScmSourceControllerWorkspaceExportArtifacts['sourceControllerMetadata'] | null;
}>): WorkspaceSyncArtifacts {
    const syncArtifacts = createWorkspaceSyncArtifactsCore({
        currentManifest: params.currentManifest,
        nextManifest: params.nextManifest,
    });

    return {
        currentManifest: syncArtifacts.currentManifest,
        nextManifest: syncArtifacts.nextManifest,
        comparison: syncArtifacts.comparison,
        removedRelativePaths: syncArtifacts.comparison.removed.map((entry) => entry.relativePath),
        changedWorkspaceArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
            manifest: createChangedWorkspaceManifest(syncArtifacts.changedEntries),
            blobContentsByDigest: new Map(),
            sourceControllerMetadata: params.sourceControllerMetadata ?? null,
        }),
    };
}

export function createWorkspaceSyncArtifacts(params: Readonly<{
    currentManifest: WorkspaceManifest;
    workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
}>): WorkspaceSyncArtifacts {
    const syncArtifacts = createWorkspaceSyncArtifactsCore({
        currentManifest: params.currentManifest,
        nextManifest: params.workspaceExportArtifacts.manifest,
    });

    return {
        currentManifest: syncArtifacts.currentManifest,
        nextManifest: syncArtifacts.nextManifest,
        comparison: syncArtifacts.comparison,
        removedRelativePaths: syncArtifacts.comparison.removed.map((entry) => entry.relativePath),
        changedWorkspaceArtifacts: createChangedWorkspaceArtifacts({
            changedEntries: syncArtifacts.changedEntries,
            sourceArtifacts: params.workspaceExportArtifacts,
        }),
    };
}
