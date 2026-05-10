import type { WorkspaceManifest } from '@happier-dev/protocol';

import {
    compareWorkspaceManifests,
    type WorkspaceManifestComparison,
} from '@/scm/workspace/workspaceExportPackaging/compareWorkspaceManifests';
import { fingerprintWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/fingerprintWorkspaceManifest';
import {
    createScmWorkspaceIntegrationWorkspaceExportArtifacts,
    type ScmWorkspaceIntegrationWorkspaceExportArtifacts,
} from '@/scm/workspace/workspaceExportArtifacts';

export type WorkspaceSyncArtifacts = Readonly<{
    currentManifest: WorkspaceManifest;
    nextManifest: WorkspaceManifest;
    comparison: WorkspaceManifestComparison;
    removedRelativePaths: readonly string[];
    changedWorkspaceArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
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
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceExportArtifacts['workspaceIntegrationMetadata'] | null;
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
        changedWorkspaceArtifacts: createScmWorkspaceIntegrationWorkspaceExportArtifacts({
            manifest: createChangedWorkspaceManifest(syncArtifacts.changedEntries),
            workspaceIntegrationMetadata: params.workspaceIntegrationMetadata ?? null,
        }),
    };
}

export function createWorkspaceSyncArtifacts(params: Readonly<{
    currentManifest: WorkspaceManifest;
    workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
}>): WorkspaceSyncArtifacts {
    return createWorkspaceSyncArtifactsFromManifest({
        currentManifest: params.currentManifest,
        nextManifest: params.workspaceExportArtifacts.manifest,
        workspaceIntegrationMetadata: params.workspaceExportArtifacts.workspaceIntegrationMetadata ?? null,
    });
}
