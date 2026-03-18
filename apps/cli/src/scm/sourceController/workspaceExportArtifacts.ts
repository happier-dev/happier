import {
    buildWorkspaceExportArtifactsFromTransferEntries,
    type WorkspaceExportArtifacts,
    type WorkspaceExportTransferEntry,
} from './workspaceExportPackaging/buildWorkspaceExportArtifactsFromTransferEntries';

import type { ScmSourceControllerWorkspaceTransferMetadata } from './workspaceTransfer';

export type ScmSourceControllerWorkspaceExportArtifacts = WorkspaceExportArtifacts & Readonly<{
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
}>;

export type ScmSourceControllerWorkspaceExportTransferEntry = WorkspaceExportTransferEntry;

export type ScmSourceControllerWorkspaceExportArtifactsWirePayload = Readonly<{
    manifest: WorkspaceExportArtifacts['manifest'];
    blobs: readonly Readonly<{
        digest: string;
        contentBase64: string;
    }>[];
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
}>;

export async function buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries(input: Readonly<{
    entries: readonly ScmSourceControllerWorkspaceExportTransferEntry[];
    shouldIgnoreAccessError?: (error: unknown) => boolean;
}>): Promise<WorkspaceExportArtifacts> {
    return await buildWorkspaceExportArtifactsFromTransferEntries(input);
}

export function cloneScmSourceControllerWorkspaceExportManifest(
    manifest: WorkspaceExportArtifacts['manifest'],
): WorkspaceExportArtifacts['manifest'] {
    return {
        entries: manifest.entries.map((entry) => ({ ...entry })),
        fingerprint: manifest.fingerprint,
    };
}

export function createScmSourceControllerWorkspaceExportArtifacts(input: Readonly<{
    manifest: WorkspaceExportArtifacts['manifest'];
    blobContentsByDigest: WorkspaceExportArtifacts['blobContentsByDigest'];
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata | null;
}>): ScmSourceControllerWorkspaceExportArtifacts {
    return {
        manifest: cloneScmSourceControllerWorkspaceExportManifest(input.manifest),
        blobContentsByDigest: new Map(input.blobContentsByDigest),
        ...(input.sourceControllerMetadata ? { sourceControllerMetadata: input.sourceControllerMetadata } : {}),
    };
}

export function createScmSourceControllerWorkspaceExportArtifactsWirePayload(
    workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts,
): ScmSourceControllerWorkspaceExportArtifactsWirePayload {
    return {
        manifest: cloneScmSourceControllerWorkspaceExportManifest(workspaceExportArtifacts.manifest),
        blobs: [...workspaceExportArtifacts.blobContentsByDigest.entries()].map(([digest, content]) => ({
            digest,
            contentBase64: Buffer.from(content).toString('base64'),
        })),
        ...(workspaceExportArtifacts.sourceControllerMetadata
            ? { sourceControllerMetadata: workspaceExportArtifacts.sourceControllerMetadata }
            : {}),
    };
}

export function parseScmSourceControllerWorkspaceExportArtifactsWirePayload(
    wirePayload: ScmSourceControllerWorkspaceExportArtifactsWirePayload,
): ScmSourceControllerWorkspaceExportArtifacts {
    return createScmSourceControllerWorkspaceExportArtifacts({
        manifest: wirePayload.manifest,
        blobContentsByDigest: new Map(
            wirePayload.blobs.map((blob) => [blob.digest, Buffer.from(blob.contentBase64, 'base64')]),
        ),
        sourceControllerMetadata: wirePayload.sourceControllerMetadata ?? null,
    });
}
