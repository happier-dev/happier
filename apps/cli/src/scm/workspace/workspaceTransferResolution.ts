import { readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import {
    createScmWorkspaceIntegrationPortableWorkspacePathRequest,
    type ScmWorkspaceIntegrationPortableWorkspacePathClassification,
} from './portableWorkspacePath';
import {
    createScmWorkspaceIntegrationWorkspaceExportArtifacts,
    type ScmWorkspaceIntegrationWorkspaceExportArtifacts,
} from './workspaceExportArtifacts';
import type { WorkspaceExportBlobProvider } from './workspaceExportStaging/stageWorkspaceEntries';
import { buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries } from './workspaceExportPackaging/artifacts/fromTransferEntries';
import {
    isIgnorableWorkspaceExportAccessError,
    listWorkspaceExportFallbackEntries,
} from './workspaceExportFallbackEntries';
import {
    DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY,
    resolveWorkspaceManifestSafeFilterPolicyFromEntries,
    type WorkspaceManifestSafeFilterPolicy,
} from './workspaceExportPackaging/workspaceManifestSafeFilterPolicy';
import {
    createScmWorkspaceIntegrationWorkspaceTransferEntry,
    createScmWorkspaceIntegrationWorkspaceTransferRequest,
    createScmWorkspaceIntegrationWorkspaceTransferResult,
    type ScmWorkspaceIntegrationWorkspaceTransferEntry,
    type ScmWorkspaceIntegrationWorkspaceTransferRequestInput,
    type ScmWorkspaceIntegrationWorkspaceTransferRequest,
    type ScmWorkspaceIntegrationWorkspaceTransferMetadata,
    type ScmWorkspaceIntegrationWorkspaceTransferResult,
} from './workspaceTransfer';
import { buildNonPortableWorkspacePathError, WorkspaceTransferSourcePathError } from './workspaceTransferErrors';

export { buildNonPortableWorkspacePathError } from './workspaceTransferErrors';

export type ScmWorkspaceIntegrationWorkspaceReplicationSourceInputs = Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    workspaceIntegrationMetadata: ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
    safeFilterPolicy: WorkspaceManifestSafeFilterPolicy;
    isNestedRepoSourcePath: boolean;
}>;

async function resolveWorkspaceTransferStateWithScmWorkspace(
    input: Readonly<{
        sourcePath: string;
        workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
        registry: ScmBackendRegistry;
    }>,
): Promise<Readonly<{
    transfer: ScmWorkspaceIntegrationWorkspaceTransferResult | null;
    isNestedRepoSourcePath: boolean;
    registry: ScmBackendRegistry;
}>> {
    const registry = input.registry;
    const resolved = await resolveScmSelection({
        workingDirectory: input.sourcePath,
        cwd: input.sourcePath,
        registry,
    });
    if (!resolved) {
        return {
            transfer: null,
            isNestedRepoSourcePath: false,
            registry,
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

    const workspaceIntegration = resolved.selection.backend.workspaceIntegration;
    const workspaceTransfer = createScmWorkspaceIntegrationWorkspaceTransferRequest(input.workspaceTransfer);
    const workspaceIntegrationInput = {
        context: resolved.context,
        workspaceTransfer,
    };

    if (workspaceIntegration?.resolveWorkspaceTransfer) {
        const transfer = await workspaceIntegration.resolveWorkspaceTransfer(workspaceIntegrationInput);
        return {
            transfer,
            isNestedRepoSourcePath,
            registry,
        };
    }

    const [entries, metadata] = await Promise.all([
        workspaceIntegration?.resolveWorkspaceTransferEntries?.(workspaceIntegrationInput) ?? Promise.resolve(null),
        workspaceIntegration?.resolveWorkspaceTransferMetadata?.(workspaceIntegrationInput) ?? Promise.resolve(null),
    ]);
    if (!entries) {
        return {
            transfer: null,
            isNestedRepoSourcePath,
            registry,
        };
    }

    return {
        transfer: createScmWorkspaceIntegrationWorkspaceTransferResult({
            entries,
            metadata,
        }),
        isNestedRepoSourcePath,
        registry,
    };
}

export function classifyPortableWorkspaceTransferEntryWithScmWorkspace(input: Readonly<{
    entry: ScmWorkspaceIntegrationWorkspaceTransferEntry;
    registry?: ScmBackendRegistry;
}>): ScmWorkspaceIntegrationPortableWorkspacePathClassification {
    const registry = input.registry;
    if (!registry) return 'unknown';
    const transferEntry = createScmWorkspaceIntegrationWorkspaceTransferEntry(input.entry);

    for (const backend of registry.listBackends()) {
        const transferEntryClassification = backend.workspaceIntegration?.classifyPortableWorkspaceTransferEntry?.(transferEntry);
        if (transferEntryClassification && transferEntryClassification !== 'unknown') {
            return transferEntryClassification;
        }

        const pathClassification = backend.workspaceIntegration?.classifyPortableWorkspacePath?.(
            createScmWorkspaceIntegrationPortableWorkspacePathRequest({
                relativePath: transferEntry.relativePath,
            }),
        );
        if (pathClassification && pathClassification !== 'unknown') {
            return pathClassification;
        }
    }

    return 'unknown';
}

export async function assertPortableWorkspaceTransferEntriesWithScmWorkspace(input: Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    await runWithScmBackendRegistryLease(input.registry, async (registry) => {
        for (const entry of input.entries) {
            if (classifyPortableWorkspaceTransferEntryWithScmWorkspace({ entry, registry }) === 'non_portable') {
                throw buildNonPortableWorkspacePathError(entry.relativePath);
            }
        }
    });
}

export async function resolveWorkspaceTransferWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceIntegrationWorkspaceTransferResult | null> {
    return runWithScmBackendRegistryLease(input.registry, async (registry) =>
        (await resolveWorkspaceTransferStateWithScmWorkspace({
            ...input,
            registry,
        })).transfer);
}

export async function resolveWorkspaceTransferEntriesWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[] | null> {
    const transfer = await resolveWorkspaceTransferWithScmWorkspace(input);
    return transfer ? transfer.entries.map((entry) => createScmWorkspaceIntegrationWorkspaceTransferEntry(entry)) : null;
}

export async function resolveWorkspaceTransferMetadataWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceIntegrationWorkspaceTransferMetadata | null> {
    const transfer = await resolveWorkspaceTransferWithScmWorkspace(input);
    return transfer ? transfer.metadata ?? null : null;
}

export async function buildWorkspaceExportManifestWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<WorkspaceManifest> {
    const sourceInputs = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace(input);
    const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: sourceInputs.entries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });

    return {
        entries: workspaceExportArtifacts.manifest.entries.map((entry) => ({ ...entry })),
        fingerprint: workspaceExportArtifacts.manifest.fingerprint,
    };
}

export async function buildWorkspaceExportArtifactsWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceIntegrationWorkspaceExportArtifacts> {
    const sourceInputs = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace(input);
    const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: sourceInputs.entries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });

    // In-memory blob maps are intentionally not supported on this path; consumers must use
    // file-backed blob providers (see buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration).
    return createScmWorkspaceIntegrationWorkspaceExportArtifacts({
        manifest: workspaceExportArtifacts.manifest,
        workspaceIntegrationMetadata: sourceInputs.workspaceIntegrationMetadata,
    });
}

export async function buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration(input: Readonly<{
    activeServerDir: string;
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<Readonly<{
    workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
    blobProvider?: WorkspaceExportBlobProvider;
}>> {
    const sourceInputs = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace(input);
    const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: sourceInputs.entries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });
    return {
        workspaceExportArtifacts: createScmWorkspaceIntegrationWorkspaceExportArtifacts({
            manifest: workspaceExportArtifacts.manifest,
            workspaceIntegrationMetadata: sourceInputs.workspaceIntegrationMetadata,
        }),
        blobProvider: workspaceExportArtifacts.blobProvider,
    };
}

export async function resolveWorkspaceReplicationSourceInputsWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceIntegrationWorkspaceReplicationSourceInputs> {
    return runWithScmBackendRegistryLease(input.registry, async (registry) => {
        const resolved = await resolveWorkspaceTransferStateWithScmWorkspace({
            ...input,
            registry,
        });

        if (resolved.transfer && !(resolved.isNestedRepoSourcePath && resolved.transfer.entries.length === 0)) {
            const entries = resolved.transfer.entries.map((entry) => createScmWorkspaceIntegrationWorkspaceTransferEntry(entry));
            await assertPortableWorkspaceTransferEntriesWithScmWorkspace({
                entries,
                registry: resolved.registry,
            });
            return {
                entries,
                workspaceIntegrationMetadata: resolved.transfer.metadata ?? null,
                safeFilterPolicy: await resolveWorkspaceManifestSafeFilterPolicyFromEntries(entries, resolved.registry),
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
            workspaceIntegrationMetadata: null,
            safeFilterPolicy: entries.length > 0
                ? await resolveWorkspaceManifestSafeFilterPolicyFromEntries(entries, resolved.registry)
                : DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY,
            isNestedRepoSourcePath: resolved.isNestedRepoSourcePath,
        };
    });
}
