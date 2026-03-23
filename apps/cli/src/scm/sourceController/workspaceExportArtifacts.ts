import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmSourceControllerWorkspaceTransferMetadata } from './workspaceTransfer';
import type { WorkspaceExportBlobProvider } from './workspaceExportStaging/stageWorkspaceEntries';
import { buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries } from './workspaceExportPackaging/buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries';
import type { WorkspaceExportTransferEntry } from './workspaceExportPackaging/workspaceExportTransferEntry';

export type ScmSourceControllerWorkspaceExportArtifacts = Readonly<{
    manifest: WorkspaceManifest;
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
}>;

export type ScmSourceControllerWorkspaceExportTransferEntry = WorkspaceExportTransferEntry;

export function cloneScmSourceControllerWorkspaceExportManifest(
    manifest: ScmSourceControllerWorkspaceExportArtifacts['manifest'],
): ScmSourceControllerWorkspaceExportArtifacts['manifest'] {
    return {
        entries: manifest.entries.map((entry) => ({ ...entry })),
        fingerprint: manifest.fingerprint,
    };
}

export function createScmSourceControllerWorkspaceExportArtifacts(input: Readonly<{
    manifest: ScmSourceControllerWorkspaceExportArtifacts['manifest'];
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata | null;
}>): ScmSourceControllerWorkspaceExportArtifacts {
    return {
        manifest: cloneScmSourceControllerWorkspaceExportManifest(input.manifest),
        ...(input.sourceControllerMetadata ? { sourceControllerMetadata: input.sourceControllerMetadata } : {}),
    };
}

export async function buildScmSourceControllerWorkspaceExportArtifactsWithBlobProviderFromTransferEntries(input: Readonly<{
    entries: readonly ScmSourceControllerWorkspaceExportTransferEntry[];
    shouldIgnoreAccessError?: (error: unknown) => boolean;
}>): Promise<Readonly<{
    workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
    blobProvider: WorkspaceExportBlobProvider;
}>> {
    const packaged = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: input.entries,
        shouldIgnoreAccessError: input.shouldIgnoreAccessError,
    });

    return {
        workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
            manifest: packaged.manifest,
            sourceControllerMetadata: null,
        }),
        blobProvider: packaged.blobProvider,
    };
}
