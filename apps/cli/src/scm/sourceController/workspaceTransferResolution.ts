import { readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { defaultScmBackendRegistry } from '../defaultRegistry';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import {
    createScmSourceControllerPortableWorkspacePathRequest,
    type ScmSourceControllerPortableWorkspacePathClassification,
} from './portableWorkspacePath';
import {
    createScmSourceControllerWorkspaceExportArtifacts,
    type ScmSourceControllerWorkspaceExportArtifacts,
} from './workspaceExportArtifacts';
import type { WorkspaceExportBlobProvider } from './workspaceExportStaging/stageWorkspaceEntries';
import { buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries } from './workspaceExportPackaging/buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries';
import {
    isIgnorableWorkspaceExportAccessError,
    listWorkspaceExportFallbackEntries,
} from './workspaceExportFallbackEntries';
import {
    DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY,
    inferWorkspaceManifestSafeFilterPolicyFromEntries,
    type WorkspaceManifestSafeFilterPolicy,
} from './workspaceExportPackaging/workspaceManifestSafeFilterPolicy';
import {
    createScmSourceControllerWorkspaceTransferEntry,
    createScmSourceControllerWorkspaceTransferRequest,
    createScmSourceControllerWorkspaceTransferResult,
    type ScmSourceControllerWorkspaceTransferEntry,
    type ScmSourceControllerWorkspaceTransferRequestInput,
    type ScmSourceControllerWorkspaceTransferRequest,
    type ScmSourceControllerWorkspaceTransferMetadata,
    type ScmSourceControllerWorkspaceTransferResult,
} from './workspaceTransfer';
import { buildNonPortableWorkspacePathError, WorkspaceTransferSourcePathError } from './workspaceTransferErrors';

export { buildNonPortableWorkspacePathError } from './workspaceTransferErrors';

export type ScmSourceControllerWorkspaceReplicationSourceInputs = Readonly<{
    entries: readonly ScmSourceControllerWorkspaceTransferEntry[];
    sourceControllerMetadata: ScmSourceControllerWorkspaceTransferMetadata | null;
    safeFilterPolicy: WorkspaceManifestSafeFilterPolicy;
    isNestedRepoSourcePath: boolean;
}>;

async function resolveWorkspaceTransferStateWithSourceController(
    input: Readonly<{
        sourcePath: string;
        workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
        registry?: ScmBackendRegistry;
    }>,
): Promise<Readonly<{
    transfer: ScmSourceControllerWorkspaceTransferResult | null;
    isNestedRepoSourcePath: boolean;
}>> {
    const resolved = await resolveScmSelection({
        workingDirectory: input.sourcePath,
        cwd: input.sourcePath,
        registry: input.registry ?? defaultScmBackendRegistry,
    });
    if (!resolved) {
        return {
            transfer: null,
            isNestedRepoSourcePath: false,
        };
    }

    const isNestedRepoSourcePath = await (async () => {
        const repoRootPath = resolved.context.detection.rootPath;
        if (!resolved.context.detection.isRepo || !repoRootPath) {
            return false;
        }

        const canonicalize = async (path: string): Promise<string> => {
            try {
                return await realpath(path);
            } catch {
                return resolve(path);
            }
        };

        const [canonicalSourcePath, canonicalRepoRootPath] = await Promise.all([
            canonicalize(input.sourcePath),
            canonicalize(repoRootPath),
        ]);
        return canonicalSourcePath !== canonicalRepoRootPath;
    })();

    const sourceController = resolved.selection.backend.sourceController;
    const workspaceTransfer = createScmSourceControllerWorkspaceTransferRequest(input.workspaceTransfer);
    const sourceControllerInput = {
        context: resolved.context,
        workspaceTransfer,
    };

    if (sourceController?.resolveWorkspaceTransfer) {
        const transfer = await sourceController.resolveWorkspaceTransfer(sourceControllerInput);
        return {
            transfer,
            isNestedRepoSourcePath,
        };
    }

    const [entries, metadata] = await Promise.all([
        sourceController?.resolveWorkspaceTransferEntries?.(sourceControllerInput) ?? Promise.resolve(null),
        sourceController?.resolveWorkspaceTransferMetadata?.(sourceControllerInput) ?? Promise.resolve(null),
    ]);
    if (!entries) {
        return {
            transfer: null,
            isNestedRepoSourcePath,
        };
    }

    return {
        transfer: createScmSourceControllerWorkspaceTransferResult({
            entries,
            metadata,
        }),
        isNestedRepoSourcePath,
    };
}

export function classifyPortableWorkspaceTransferEntryWithSourceController(input: Readonly<{
    entry: ScmSourceControllerWorkspaceTransferEntry;
    registry?: ScmBackendRegistry;
}>): ScmSourceControllerPortableWorkspacePathClassification {
    const registry = input.registry ?? defaultScmBackendRegistry;
    const transferEntry = createScmSourceControllerWorkspaceTransferEntry(input.entry);

    for (const backend of registry.listBackends()) {
        const transferEntryClassification = backend.sourceController?.classifyPortableWorkspaceTransferEntry?.(transferEntry);
        if (transferEntryClassification && transferEntryClassification !== 'unknown') {
            return transferEntryClassification;
        }

        const pathClassification = backend.sourceController?.classifyPortableWorkspacePath?.(
            createScmSourceControllerPortableWorkspacePathRequest({
                relativePath: transferEntry.relativePath,
            }),
        );
        if (pathClassification && pathClassification !== 'unknown') {
            return pathClassification;
        }
    }

    return 'unknown';
}

export async function assertPortableWorkspaceTransferEntriesWithSourceController(input: Readonly<{
    entries: readonly ScmSourceControllerWorkspaceTransferEntry[];
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    for (const entry of input.entries) {
        if (classifyPortableWorkspaceTransferEntryWithSourceController({ entry, registry: input.registry }) === 'non_portable') {
            throw buildNonPortableWorkspacePathError(entry.relativePath);
        }
    }
}

export async function resolveWorkspaceTransferWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceTransferResult | null> {
    return (await resolveWorkspaceTransferStateWithSourceController(input)).transfer;
}

export async function resolveWorkspaceTransferEntriesWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<readonly ScmSourceControllerWorkspaceTransferEntry[] | null> {
    const transfer = await resolveWorkspaceTransferWithSourceController(input);
    return transfer ? transfer.entries.map((entry) => createScmSourceControllerWorkspaceTransferEntry(entry)) : null;
}

export async function resolveWorkspaceTransferMetadataWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceTransferMetadata | null> {
    const transfer = await resolveWorkspaceTransferWithSourceController(input);
    return transfer ? transfer.metadata ?? null : null;
}

export async function buildWorkspaceExportManifestWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<WorkspaceManifest> {
    const sourceInputs = await resolveWorkspaceReplicationSourceInputsWithSourceController(input);
    const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: sourceInputs.entries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });

    return {
        entries: workspaceExportArtifacts.manifest.entries.map((entry) => ({ ...entry })),
        fingerprint: workspaceExportArtifacts.manifest.fingerprint,
    };
}

export async function buildWorkspaceExportArtifactsWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceExportArtifacts> {
    const sourceInputs = await resolveWorkspaceReplicationSourceInputsWithSourceController(input);
    const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: sourceInputs.entries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });

    // In-memory blob maps are intentionally not supported on this path; consumers must use
    // file-backed blob providers (see buildWorkspaceExportArtifactsWithBlobProviderFromSourceController).
    return createScmSourceControllerWorkspaceExportArtifacts({
        manifest: workspaceExportArtifacts.manifest,
        sourceControllerMetadata: sourceInputs.sourceControllerMetadata,
    });
}

export async function buildWorkspaceExportArtifactsWithBlobProviderFromSourceController(input: Readonly<{
    activeServerDir: string;
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<Readonly<{
    workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
    blobProvider?: WorkspaceExportBlobProvider;
}>> {
    const sourceInputs = await resolveWorkspaceReplicationSourceInputsWithSourceController(input);
    const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: sourceInputs.entries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });
    return {
        workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
            manifest: workspaceExportArtifacts.manifest,
            sourceControllerMetadata: sourceInputs.sourceControllerMetadata,
        }),
        blobProvider: workspaceExportArtifacts.blobProvider,
    };
}

export async function resolveWorkspaceReplicationSourceInputsWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceReplicationSourceInputs> {
    const resolved = await resolveWorkspaceTransferStateWithSourceController(input);

    if (resolved.transfer && !(resolved.isNestedRepoSourcePath && resolved.transfer.entries.length === 0)) {
        const entries = resolved.transfer.entries.map((entry) => createScmSourceControllerWorkspaceTransferEntry(entry));
        await assertPortableWorkspaceTransferEntriesWithSourceController({
            entries,
            registry: input.registry,
        });
        return {
            entries,
            sourceControllerMetadata: resolved.transfer.metadata ?? null,
            safeFilterPolicy: inferWorkspaceManifestSafeFilterPolicyFromEntries(entries, input.registry),
            isNestedRepoSourcePath: resolved.isNestedRepoSourcePath,
        };
    }

    try {
        await readdir(input.sourcePath, { withFileTypes: true });
    } catch (error) {
        if (isIgnorableWorkspaceExportAccessError(error)) {
            throw new WorkspaceTransferSourcePathError({
                sourcePath: input.sourcePath,
                cause: error,
            });
        }
        throw error;
    }

    const entries = await listWorkspaceExportFallbackEntries({
        root: input.sourcePath,
        readDirectory: async (directory) => await readdir(directory, { withFileTypes: true }),
    });
    return {
        entries,
        sourceControllerMetadata: null,
        safeFilterPolicy: entries.length > 0
            ? inferWorkspaceManifestSafeFilterPolicyFromEntries(entries, input.registry)
            : DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY,
        isNestedRepoSourcePath: resolved.isNestedRepoSourcePath,
    };
}
