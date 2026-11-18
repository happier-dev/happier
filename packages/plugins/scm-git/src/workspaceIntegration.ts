import type {
    ScmBackendContext,
    ScmWorkspaceIntegration,
    ScmWorkspaceIntegrationPostMaterializationInput,
    ScmWorkspaceIntegrationPortableWorkspacePathInput,
    ScmWorkspaceIntegrationPortableWorkspaceEntriesInput,
    ScmWorkspaceIntegrationWorkspaceCheckoutCreationInput,
    ScmWorkspaceIntegrationWorkspaceCheckoutRealizationInput,
    ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
    ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput,
    ScmWorkspaceIntegrationWorkspaceTransferInput,
    ScmWorkspaceIntegrationWorkspaceTransferResult,
    ScmWorkspaceIntegrationWorkspaceLocationInspection,
} from './types.js';
import { createScmWorkspaceIntegrationWorkspaceTransferResult } from './workspace/workspaceTransfer.js';
import {
    resolveScmWorkspaceIntegrationCheckoutMaterializationPreviousTargetPath,
    resolveScmWorkspaceIntegrationCheckoutMaterializationSourcePath,
} from './workspace/checkoutMaterialization.js';
import {
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationBaseRef,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationBranchMode,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationDisplayName,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationKind,
} from './workspace/workspaceCheckoutCreation.js';
import { resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath } from './workspace/portableWorkspacePath.js';
import {
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBaseRef,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBranchMode,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationDisplayName,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationKind,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationTargetPath,
} from './workspace/workspaceCheckoutMaterialization.js';
import {
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBaseRef,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBranchMode,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationDisplayName,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationKind,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationSourcePath,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationTargetPath,
} from './workspace/workspaceCheckoutRealization.js';
import type { ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult } from './workspace/workspaceCheckoutCreation.js';

import { inspectGitCheckoutIdentity, inspectGitMainWorktreePath } from './checkoutIdentity.js';
import {
    createGitWorkspaceCheckoutAtDefaultPath,
    materializeGitWorkspaceCheckoutAtPath,
    prepareGitReviewWorkspace,
    readGitRevision,
} from './operations/materializeGitWorkspaceCheckout.js';
import { reconcileGitWorkspaceCheckout } from './operations/reconcileWorkspaceCheckout.js';
import { resolveGitWorkspaceTransferEntries, resolveGitWorkspaceTransferSelection } from './operations/resolveGitWorkspaceTransferEntries.js';
import { resolveGitWorkspaceTransferMetadata } from './workspaceTransferMetadata.js';
import {
    materializePortableGitWorkspaceBundle,
    preparePortableGitWorkspaceTransfer,
    resolvePortableGitWorkspaceRoot,
} from './workspace/portableGitWorkspaceTransfer.js';

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function classifyGitPortableWorkspacePath(
    input: ScmWorkspaceIntegrationPortableWorkspacePathInput,
): 'portable' | 'non_portable' | 'unknown' {
    const normalizedRelativePath = normalizeRelativePath(resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath(input));
    if (normalizedRelativePath === '.git' || normalizedRelativePath.startsWith('.git/')) {
        return 'non_portable';
    }

    return 'unknown';
}

export async function inspectGitWorkspaceLocation(input: Readonly<{
    context: ScmBackendContext;
}>): Promise<ScmWorkspaceIntegrationWorkspaceLocationInspection | null> {
    if (!input.context.detection.isRepo || !input.context.detection.rootPath) {
        return null;
    }

    const identity = await inspectGitCheckoutIdentity({ cwd: input.context.cwd });
    const committedRevision = await readGitRevision({ cwd: input.context.cwd });
    const parentRootPath = identity && identity.gitDirPath !== identity.commonDirPath
        ? await inspectGitMainWorktreePath({ cwd: input.context.cwd, currentWorktreePath: identity.worktreePath }) : null;

    return {
        rootPath: input.context.detection.rootPath,
        scmProvider: 'git',
        ...(committedRevision ? { committedRevision } : {}),
        checkoutDiscovery: [{
            kind: 'git_worktree',
            path: identity?.registeredWorktreePath ?? identity?.worktreePath,
            ...(identity?.commonDirPath ? { repositoryIdentityPath: identity.commonDirPath } : {}),
            ...(parentRootPath && parentRootPath !== identity?.worktreePath ? { parentRootPath } : {}),
        }],
    };
}

export async function reconcileGitWorkspacePostMaterialization(input: ScmWorkspaceIntegrationPostMaterializationInput): Promise<void> {
    await materializePortableGitWorkspaceBundle({
        targetPath: input.context.cwd,
        workspaceIntegrationMetadata: input.workspaceIntegrationMetadata,
    });
    await reconcileGitWorkspaceCheckout({
        context: input.context,
        sourcePath: resolveScmWorkspaceIntegrationCheckoutMaterializationSourcePath(input.checkoutMaterialization),
        previousTargetPath: resolveScmWorkspaceIntegrationCheckoutMaterializationPreviousTargetPath(input.checkoutMaterialization),
        workspaceIntegrationMetadata: input.workspaceIntegrationMetadata,
    });
}

export function resolveGitRepoRoot(context: ScmBackendContext): string {
    if (!context.detection.isRepo || !context.detection.rootPath) {
        throw new Error('Git workspace checkout creation requires a repository root');
    }

    return context.detection.rootPath;
}

export async function createGitWorkspaceCheckout(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutCreationInput,
): Promise<ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult> {
    const checkoutKind = resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationKind(input.workspaceCheckoutCreation);
    if (checkoutKind !== 'git_worktree') {
        throw new Error(`Unsupported Git workspace checkout creation kind: ${checkoutKind}`);
    }

    const created = await createGitWorkspaceCheckoutAtDefaultPath({
        repoRoot: resolveGitRepoRoot(input.context),
        displayName: resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationDisplayName(input.workspaceCheckoutCreation),
        baseRef: resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationBaseRef(input.workspaceCheckoutCreation),
        branchMode: resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationBranchMode(input.workspaceCheckoutCreation),
        assertFilesystemPathAuthorized: input.context.assertFilesystemPathAuthorized,
    });

    return {
        kind: checkoutKind,
        targetPath: created.targetPath,
        branchName: created.branchName,
        created: !created.reused,
    };
}

export async function materializeGitWorkspaceSourceCheckout(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput,
): Promise<Readonly<{
    targetPath: string;
    branchName: string;
    created: boolean;
}>> {
    const checkoutKind = resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationKind(input.workspaceCheckoutMaterialization);
    if (checkoutKind !== 'git_worktree') {
        throw new Error(`Unsupported Git workspace checkout materialization kind: ${checkoutKind}`);
    }

    const materialized = await materializeGitWorkspaceCheckoutAtPath({
        repoRoot: resolveGitRepoRoot(input.context),
        targetPath: resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationTargetPath(input.workspaceCheckoutMaterialization),
        displayName: resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationDisplayName(input.workspaceCheckoutMaterialization),
        baseRef: resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBaseRef(input.workspaceCheckoutMaterialization),
        branchMode: resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBranchMode(input.workspaceCheckoutMaterialization),
        assertFilesystemPathAuthorized: input.context.assertFilesystemPathAuthorized,
    });

    return {
        targetPath: materialized.targetPath,
        branchName: materialized.branchName,
        created: !materialized.reused,
    };
}

export async function prepareGitReviewWorkspaceAtSelectedRoot(input: Readonly<{
    context: ScmBackendContext;
    request: Readonly<{
        sourceTip: Parameters<typeof prepareGitReviewWorkspace>[0]['sourceTip'];
    }>;
    signal: AbortSignal;
}>) {
    try {
        const prepared = await prepareGitReviewWorkspace({
            repoRoot: resolveGitRepoRoot(input.context),
            sourceTip: input.request.sourceTip,
            signal: input.signal,
            assertFilesystemPathAuthorized: input.context.assertFilesystemPathAuthorized,
        });
        return {
            success: true as const,
            targetPath: prepared.targetPath,
            branchName: prepared.branchName,
            created: prepared.created,
            currentness: prepared.currentness,
        };
    } catch (error) {
        return {
            success: false as const,
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof Error && 'errorCode' in error && error.errorCode === 'INVALID_PATH'
                ? 'INVALID_PATH' as const
                : 'COMMAND_FAILED' as const,
        };
    }
}

/**
 * Reports the current local HEAD of one already-prepared checkout. Provider
 * currentness remains source-owned, so this deliberately performs no fetch,
 * repair, branch movement, or rematerialization.
 */
export async function verifyGitPreparedReviewWorkspace(
    input: Parameters<NonNullable<ScmWorkspaceIntegration['verifyPreparedReviewWorkspace']>>[0],
) {
    try {
        input.signal.throwIfAborted();
        const sourceHeadSha = await readGitRevision({
            cwd: input.request.verification.targetPath,
            signal: input.signal,
        });
        input.signal.throwIfAborted();
        if (!sourceHeadSha) {
            return {
                success: false as const,
                error: 'The prepared review workspace has no readable local HEAD',
                errorCode: 'NOT_REPOSITORY' as const,
            };
        }
        return {
            success: true as const,
            verification: {
                targetPath: input.request.verification.targetPath,
                sourceHeadSha,
            },
        };
    } catch (error) {
        input.signal.throwIfAborted();
        return {
            success: false as const,
            error: error instanceof Error ? error.message : String(error),
            errorCode: 'COMMAND_FAILED' as const,
        };
    }
}

export async function realizeGitWorkspaceCheckout(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationInput,
): Promise<ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult> {
    const checkoutKind = resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationKind(input.workspaceCheckoutRealization);
    if (checkoutKind !== 'git_worktree') {
        throw new Error(`Unsupported Git workspace checkout realization kind: ${checkoutKind}`);
    }

    const targetPath = resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationTargetPath(input.workspaceCheckoutRealization);
    if (targetPath) {
        const materialized = await materializeGitWorkspaceCheckoutAtPath({
            repoRoot: resolveGitRepoRoot(input.context),
            targetPath,
            displayName: resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationDisplayName(input.workspaceCheckoutRealization),
            baseRef: resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBaseRef(input.workspaceCheckoutRealization),
            branchMode: resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBranchMode(input.workspaceCheckoutRealization),
            assertFilesystemPathAuthorized: input.context.assertFilesystemPathAuthorized,
        });

        return {
            kind: checkoutKind,
            targetPath: materialized.targetPath,
            branchName: materialized.branchName,
            created: !materialized.reused,
        };
    }

    return await createGitWorkspaceCheckout({
        context: input.context,
        workspaceCheckoutCreation: {
            kind: checkoutKind,
            sourcePath: resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationSourcePath(input.workspaceCheckoutRealization),
            displayName: resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationDisplayName(input.workspaceCheckoutRealization),
            baseRef: resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBaseRef(input.workspaceCheckoutRealization),
            branchMode: resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBranchMode(input.workspaceCheckoutRealization),
        },
    });
}

/**
 * Resolves entries and metadata from one observation of the worktree. The
 * portable path stages a Git bundle while listing entries, so the metadata that
 * names that bundle must come from the same call: resolving them separately
 * re-reads HEAD and the worktree root and can describe an artifact the returned
 * entries never contained.
 */
export async function resolveGitWorkspaceTransferSource(
    input: ScmWorkspaceIntegrationWorkspaceTransferInput,
): Promise<ScmWorkspaceIntegrationWorkspaceTransferResult | null> {
    if (input.workspaceTransfer.strategy === 'transfer_snapshot' && input.artifactDirectory) {
        return await preparePortableGitWorkspaceTransfer({
            ...input,
            artifactDirectory: input.artifactDirectory,
        });
    }
    return createScmWorkspaceIntegrationWorkspaceTransferResult({
        ...await resolveGitWorkspaceTransferSelection(input),
        metadata: await resolveGitWorkspaceTransferMetadata(input),
    });
}

export async function resolveGitWorkspaceTransferSourceEntries(input: ScmWorkspaceIntegrationWorkspaceTransferInput) {
    if (input.workspaceTransfer.strategy === 'transfer_snapshot' && input.artifactDirectory) {
        return (await preparePortableGitWorkspaceTransfer({
            ...input,
            artifactDirectory: input.artifactDirectory,
        })).entries;
    }
    return await resolveGitWorkspaceTransferEntries(input);
}

export async function resolveGitWorkspaceTransferSourceMetadata(input: ScmWorkspaceIntegrationWorkspaceTransferInput) {
    const metadata = await resolveGitWorkspaceTransferMetadata(input);
    if (!metadata || input.workspaceTransfer.strategy !== 'transfer_snapshot' || !input.artifactDirectory) {
        return metadata;
    }
    const detectedRepositoryRoot = input.context.detection.rootPath;
    if (!detectedRepositoryRoot) return null;
    const transferRoot = await resolvePortableGitWorkspaceRoot({
        cwd: input.context.cwd,
        repositoryRoot: detectedRepositoryRoot,
    });
    return {
        ...metadata,
        ...transferRoot,
        portableBundle: { v: 1 as const, relativePath: '.happier-scm/git.bundle' as const },
    };
}

export function classifyGitPortableWorkspaceTransferEntry(input: Readonly<{
    relativePath: string;
    sourcePath: string;
}>): 'portable' | 'non_portable' | 'unknown' {
    return classifyGitPortableWorkspacePath({
        relativePath: input.relativePath,
    });
}

export async function assertPortableGitWorkspaceEntries(
    input: ScmWorkspaceIntegrationPortableWorkspaceEntriesInput,
): Promise<void> {
    if (!input.entries.some((entry) => classifyGitPortableWorkspacePath(entry) === 'non_portable')) {
        return;
    }

    throw Object.assign(new Error('Workspace transfer contains non-portable git worktree admin state; portable git metadata import was refused'), { code: 'git_selection_unavailable' });
}

export function isGitAdministrativeWorkspacePath(input: Readonly<{
    relativePath: string;
}>): boolean {
    // Exports can cross from case-sensitive worktrees to case-insensitive hosts.
    const normalizedRelativePath = normalizeRelativePath(input.relativePath).toLowerCase();
    return normalizedRelativePath === '.git' || normalizedRelativePath.startsWith('.git/');
}
