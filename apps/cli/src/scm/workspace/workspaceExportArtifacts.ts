import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmWorkspaceIntegrationWorkspaceTransferMetadata } from './workspaceTransfer';
import type { WorkspaceExportBlobProvider } from './workspaceExportStaging/stageWorkspaceEntries';
import { buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries } from './workspaceExportPackaging/artifacts/fromTransferEntries';
import type { WorkspaceExportTransferEntry } from './workspaceExportPackaging/workspaceExportTransferEntry';

export type ScmWorkspaceIntegrationWorkspaceExportArtifacts = Readonly<{
    manifest: WorkspaceManifest;
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
}>;

export type ScmWorkspaceIntegrationWorkspaceExportTransferEntry = WorkspaceExportTransferEntry;

export function cloneScmWorkspaceIntegrationWorkspaceExportManifest(
    manifest: ScmWorkspaceIntegrationWorkspaceExportArtifacts['manifest'],
): ScmWorkspaceIntegrationWorkspaceExportArtifacts['manifest'] {
    return {
        entries: manifest.entries.map((entry) => ({ ...entry })),
        fingerprint: manifest.fingerprint,
    };
}

export function createScmWorkspaceIntegrationWorkspaceExportArtifacts(input: Readonly<{
    manifest: ScmWorkspaceIntegrationWorkspaceExportArtifacts['manifest'];
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
}>): ScmWorkspaceIntegrationWorkspaceExportArtifacts {
    return {
        manifest: cloneScmWorkspaceIntegrationWorkspaceExportManifest(input.manifest),
        ...(input.workspaceIntegrationMetadata ? { workspaceIntegrationMetadata: input.workspaceIntegrationMetadata } : {}),
    };
}

export async function buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries(input: Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceExportTransferEntry[];
    shouldIgnoreAccessError?: (error: unknown) => boolean;
}>): Promise<Readonly<{
    workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
    blobProvider: WorkspaceExportBlobProvider;
}>> {
    const packaged = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: input.entries,
        shouldIgnoreAccessError: input.shouldIgnoreAccessError,
    });

    return {
        workspaceExportArtifacts: createScmWorkspaceIntegrationWorkspaceExportArtifacts({
            manifest: packaged.manifest,
            workspaceIntegrationMetadata: null,
        }),
        blobProvider: packaged.blobProvider,
    };
}
