import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { join, resolve } from 'node:path';

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
import { buildNonPortableWorkspacePathError, WorkspaceTransferSourcePathError, WorkspaceTransferUnsupportedPathError } from './workspaceTransferErrors';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { isAdministrativeWorkspacePathWithScmWorkspace } from './workspacePortability';
import { normalizeWorkspacePath } from './workspaceExportPackaging/normalizeWorkspacePath';

export { buildNonPortableWorkspacePathError } from './workspaceTransferErrors';

export type ScmWorkspaceIntegrationWorkspaceReplicationSourceInputs = Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    excludedPaths?: readonly string[];
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
        ...(input.workspaceTransfer.contentOnly ? {} : { artifactDirectory: input.activeServerDir }),
    });
    const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
        entries: sourceInputs.entries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });
    return {
        workspaceExportArtifacts: createScmWorkspaceIntegrationWorkspaceExportArtifacts({
            manifest: workspaceExportArtifacts.manifest,
            excludedPaths: sourceInputs.excludedPaths,
            workspaceIntegrationMetadata: input.workspaceTransfer.contentOnly ? null : sourceInputs.workspaceIntegrationMetadata,
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
            artifactDirectory: input.workspaceTransfer.contentOnly ? undefined : input.artifactDirectory,
            registry,
        });

        if (resolved.transfer && !(resolved.isNestedRepoSourcePath
            && resolved.transfer.entries.length === 0
            && resolved.transfer.excludedPaths === undefined)) {
            const entries = await selectWorkspaceTransferContentEntries({
                entries: resolved.transfer.entries.map((entry) => createScmWorkspaceIntegrationWorkspaceTransferEntry(entry)),
                sourceRoot: input.sourcePath, contentOnly: input.workspaceTransfer.contentOnly, registry,
            });
            await assertPortableWorkspaceTransferEntriesWithScmWorkspace({
                entries,
                registry: resolved.registry,
            });
            return {
                entries,
                ...(resolved.transfer.excludedPaths ? { excludedPaths: resolved.transfer.excludedPaths } : {}),
                workspaceIntegrationMetadata: input.workspaceTransfer.contentOnly ? null : resolved.transfer.metadata ?? null,
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

        const entries = await selectWorkspaceTransferContentEntries({ entries: await listWorkspaceExportFallbackEntries({
            root: input.sourcePath,
            readDirectory: async (directory) => await currentWorkspaceSource().readdir(directory),
        }), sourceRoot: input.sourcePath, contentOnly: input.workspaceTransfer.contentOnly, registry });
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

async function selectWorkspaceTransferContentEntries(input: Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    sourceRoot: string;
    contentOnly?: true;
    registry: ScmBackendRegistry;
}>): Promise<readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[]> {
    if (!input.contentOnly) return input.entries;
    const administrativeEntries = new Set(input.entries.filter(entry => isAdministrativeWorkspacePathWithScmWorkspace({
        relativePath: entry.relativePath, registry: input.registry,
    })));
    const nestedRoots = new Set<string>();
    for (const entry of administrativeEntries) {
        const parts = normalizeWorkspacePath(entry.relativePath).split('/');
        for (let index = 0; index < parts.length; index++) {
            if (!isAdministrativeWorkspacePathWithScmWorkspace({ relativePath: parts.slice(0, index + 1).join('/'), registry: input.registry })) continue;
            if (index > 0) nestedRoots.add(parts.slice(0, index).join('/'));
            break;
        }
    }
    for (const path of nestedRoots) {
        const sourcePath = join(input.sourceRoot, ...path.split('/'));
        const nested = await resolveWorkspaceTransferRootWithScmWorkspace({ sessionCwd: sourcePath, registry: input.registry });
        if (nested && nested.repositoryRoot === await currentWorkspaceSource().realpath(sourcePath)) refuseNestedRepository(path);
    }
    const entries = input.entries.filter(entry => !administrativeEntries.has(entry));
    for (const entry of entries) {
        const stats = await currentWorkspaceSource().lstat(entry.sourcePath).catch(error => {
            if (isIgnorableWorkspaceExportAccessError(error)) return null;
            throw error;
        });
        if (!stats?.isDirectory()) continue;
        const nested = await resolveWorkspaceTransferRootWithScmWorkspace({ sessionCwd: entry.sourcePath, registry: input.registry });
        if (nested && nested.repositoryRoot === await currentWorkspaceSource().realpath(entry.sourcePath)) {
            const path = normalizeWorkspacePath(entry.relativePath).replace(/\/$/u, '');
            refuseNestedRepository(path);
        }
    }
    return entries;
}

function refuseNestedRepository(path: string): never {
    throw new WorkspaceTransferUnsupportedPathError(path);
}
