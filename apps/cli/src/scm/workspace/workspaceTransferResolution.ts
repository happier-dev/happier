import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { resolve } from 'node:path';

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
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';

export { buildNonPortableWorkspacePathError } from './workspaceTransferErrors';

export type ScmWorkspaceIntegrationWorkspaceReplicationSourceInputs = Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    workspaceIntegrationMetadata: ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
    safeFilterPolicy: WorkspaceManifestSafeFilterPolicy;
    isNestedRepoSourcePath: boolean;
}>;

export type ScmWorkspaceTransferRoot = Readonly<{
    repositoryRoot: string;
    sessionRelativeCwd: string;
}>;

/**
 * Resolves the exact SCM worktree root that owns a finite transfer. The
 * session cwd remains presentation/runtime state and is represented only as a
 * contained relative path; it never narrows the repository materialization.
 */
export async function resolveWorkspaceTransferRootWithScmWorkspace(input: Readonly<{
    sessionCwd: string;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceTransferRoot | null> {
    return await runWithScmBackendRegistryLease(input.registry, async (registry) => {
        const resolved = await resolveScmSelection({
            workingDirectory: input.sessionCwd,
            cwd: input.sessionCwd,
            registry,
        });
        if (!resolved?.context.detection.isRepo || !resolved.context.detection.rootPath) return null;
        const inspection = await resolved.selection.backend.workspaceIntegration?.inspectWorkspaceLocation?.({
            context: resolved.context,
        });
        if (inspection?.scmProvider !== 'git') return null;
        const [repositoryRoot, sessionCwd] = await Promise.all([
            currentWorkspaceSource().realpath(inspection.rootPath).catch(() => null),
            currentWorkspaceSource().realpath(input.sessionCwd).catch(() => null),
        ]);
        if (!repositoryRoot || !sessionCwd) {
            throw Object.assign(new Error('Git worktree root or session directory is unavailable'), {
                code: 'git_selection_unavailable',
            });
        }
        const sessionRelativeCwd = getPathRemainderWithinBase(sessionCwd, repositoryRoot);
        if (sessionRelativeCwd === null) {
            throw Object.assign(new Error('Git session directory escapes the selected worktree root'), {
                code: 'git_selection_unavailable',
            });
        }
        return { repositoryRoot, sessionRelativeCwd };
    });
}

async function resolveWorkspaceTransferStateWithScmWorkspace(
    input: Readonly<{
        sourcePath: string;
        workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
        artifactDirectory?: string;
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
                return await currentWorkspaceSource().realpath(path);
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
        ...(input.artifactDirectory ? { artifactDirectory: input.artifactDirectory } : {}),
    };

    if (workspaceIntegration?.resolveWorkspaceTransfer) {
        const transfer = await workspaceIntegration.resolveWorkspaceTransfer(workspaceIntegrationInput);
        return {
            transfer,
            isNestedRepoSourcePath,
            registry,
        };
    }

    if (workspaceTransfer.includeAllIgnored === true
        || (workspaceTransfer.extraIgnorePatterns?.length ?? 0) > 0) {
        throw Object.assign(
            new Error('The selected SCM backend cannot apply the workspace seed content policy atomically'),
            { code: 'git_selection_unavailable' },
        );
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

function classifyPortableWorkspaceTransferEntryWithScmWorkspace(input: Readonly<{
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

export async function buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration(input: Readonly<{
    activeServerDir: string;
    sourcePath: string;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<Readonly<{
    workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
    blobProvider?: WorkspaceExportBlobProvider;
}>> {
    const sourceInputs = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace({
        ...input,
        artifactDirectory: input.activeServerDir,
    });
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
    artifactDirectory?: string;
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
            await currentWorkspaceSource().readdir(input.sourcePath);
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
            readDirectory: async (directory) => await currentWorkspaceSource().readdir(directory),
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
