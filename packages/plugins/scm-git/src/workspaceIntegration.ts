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
    ScmWorkspaceIntegrationWorkspaceLocationInspection,
} from './types.js';
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

import { inspectGitCheckoutIdentity } from './checkoutIdentity.js';
import {
    createGitWorkspaceCheckoutAtDefaultPath,
    materializeGitWorkspaceCheckoutAtPath,
    prepareGitReviewWorkspace,
    readGitRevision,
} from './operations/materializeGitWorkspaceCheckout.js';
import { reconcileGitWorkspaceCheckout } from './operations/reconcileWorkspaceCheckout.js';
import { resolveGitWorkspaceTransferEntries } from './operations/resolveGitWorkspaceTransferEntries.js';
import { resolveGitWorkspaceTransferMetadata } from './workspaceTransferMetadata.js';

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function classifyGitPortableWorkspacePath(
    input: ScmWorkspaceIntegrationPortableWorkspacePathInput,
): 'portable' | 'non_portable' | 'unknown' {
    const normalizedRelativePath = normalizeRelativePath(resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath(input));
    if (
        normalizedRelativePath === '.git/commondir'
        || normalizedRelativePath === '.git/gitdir'
        || normalizedRelativePath === '.git/worktrees'
        || normalizedRelativePath.startsWith('.git/worktrees/')
    ) {
        return 'non_portable';
    }
    if (normalizedRelativePath === '.git' || normalizedRelativePath.startsWith('.git/')) {
        return 'portable';
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

    return {
        rootPath: input.context.detection.rootPath,
        scmProvider: 'git',
        checkoutDiscovery: [{
            kind: 'git_worktree',
            path: identity?.registeredWorktreePath ?? identity?.worktreePath,
        }],
    };
}

export async function reconcileGitWorkspacePostMaterialization(input: ScmWorkspaceIntegrationPostMaterializationInput): Promise<void> {
    await reconcileGitWorkspaceCheckout({
        context: input.context,
        sourcePath: resolveScmWorkspaceIntegrationCheckoutMaterializationSourcePath(input.checkoutMaterialization),
        previousTargetPath: resolveScmWorkspaceIntegrationCheckoutMaterializationPreviousTargetPath(input.checkoutMaterialization),
        workspaceIntegrationMetadata: input.workspaceIntegrationMetadata,
    });
}

function resolveGitRepoRoot(context: ScmBackendContext): string {
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
            errorCode: 'COMMAND_FAILED' as const,
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

export async function resolveGitWorkspaceTransferSourceEntries(input: ScmWorkspaceIntegrationWorkspaceTransferInput) {
    return await resolveGitWorkspaceTransferEntries(input);
}

export async function resolveGitWorkspaceTransferSourceMetadata(input: ScmWorkspaceIntegrationWorkspaceTransferInput) {
    return await resolveGitWorkspaceTransferMetadata(input);
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

    throw new Error('Workspace transfer contains non-portable git worktree admin state; portable git metadata import was refused');
}

export function isGitAdministrativeWorkspacePath(input: Readonly<{
    relativePath: string;
}>): boolean {
    const normalizedRelativePath = normalizeRelativePath(input.relativePath);
    return normalizedRelativePath === '.git' || normalizedRelativePath.startsWith('.git/');
}
