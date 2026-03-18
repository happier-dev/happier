import type {
    ScmBackendContext,
    ScmSourceControllerPostMaterializationInput,
    ScmSourceControllerPortableWorkspacePathInput,
    ScmSourceControllerPortableWorkspaceEntriesInput,
    ScmSourceControllerWorkspaceCheckoutCreationInput,
    ScmSourceControllerWorkspaceCheckoutRealizationInput,
    ScmSourceControllerWorkspaceCheckoutRealizationResult,
    ScmSourceControllerWorkspaceCheckoutMaterializationInput,
    ScmSourceControllerWorkspaceTransferInput,
    ScmSourceControllerWorkspaceLocationInspection,
} from '../../types';
import {
    resolveScmSourceControllerCheckoutMaterializationPreviousTargetPath,
    resolveScmSourceControllerCheckoutMaterializationSourcePath,
} from '../../sourceController/checkoutMaterialization';
import {
    resolveScmSourceControllerWorkspaceCheckoutCreationBaseRef,
    resolveScmSourceControllerWorkspaceCheckoutCreationDisplayName,
    resolveScmSourceControllerWorkspaceCheckoutCreationKind,
} from '../../sourceController/workspaceCheckoutCreation';
import { resolveScmSourceControllerPortableWorkspacePathRelativePath } from '../../sourceController/portableWorkspacePath';
import {
    resolveScmSourceControllerWorkspaceCheckoutMaterializationBaseRef,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationDisplayName,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationKind,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationTargetPath,
} from '../../sourceController/workspaceCheckoutMaterialization';
import {
    resolveScmSourceControllerWorkspaceCheckoutRealizationBaseRef,
    resolveScmSourceControllerWorkspaceCheckoutRealizationDisplayName,
    resolveScmSourceControllerWorkspaceCheckoutRealizationKind,
    resolveScmSourceControllerWorkspaceCheckoutRealizationSourcePath,
    resolveScmSourceControllerWorkspaceCheckoutRealizationTargetPath,
} from '../../sourceController/workspaceCheckoutRealization';
import type { ScmSourceControllerWorkspaceCheckoutCreationResult } from '../../sourceController/workspaceCheckoutCreation';

import { inspectGitCheckoutIdentity } from './checkoutIdentity';
import {
    createGitWorkspaceCheckoutAtDefaultPath,
    materializeGitWorkspaceCheckoutAtPath,
} from './operations/materializeGitWorkspaceCheckout';
import { reconcileGitWorkspaceCheckout } from './operations/reconcileWorkspaceCheckout';
import { resolveGitWorkspaceTransferEntries } from './operations/resolveGitWorkspaceTransferEntries';
import { resolveGitWorkspaceTransferMetadata } from './workspaceTransferMetadata';

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function classifyGitPortableWorkspacePath(
    input: ScmSourceControllerPortableWorkspacePathInput,
): 'portable' | 'non_portable' | 'unknown' {
    const normalizedRelativePath = normalizeRelativePath(resolveScmSourceControllerPortableWorkspacePathRelativePath(input));
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
}>): Promise<ScmSourceControllerWorkspaceLocationInspection | null> {
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

export async function reconcileGitWorkspacePostMaterialization(input: ScmSourceControllerPostMaterializationInput): Promise<void> {
    await reconcileGitWorkspaceCheckout({
        context: input.context,
        sourcePath: resolveScmSourceControllerCheckoutMaterializationSourcePath(input.checkoutMaterialization),
        previousTargetPath: resolveScmSourceControllerCheckoutMaterializationPreviousTargetPath(input.checkoutMaterialization),
        sourceControllerMetadata: input.sourceControllerMetadata,
    });
}

function resolveGitRepoRoot(context: ScmBackendContext): string {
    if (!context.detection.isRepo || !context.detection.rootPath) {
        throw new Error('Git workspace checkout creation requires a repository root');
    }

    return context.detection.rootPath;
}

export async function createGitWorkspaceCheckout(
    input: ScmSourceControllerWorkspaceCheckoutCreationInput,
): Promise<ScmSourceControllerWorkspaceCheckoutCreationResult> {
    const checkoutKind = resolveScmSourceControllerWorkspaceCheckoutCreationKind(input.workspaceCheckoutCreation);
    if (checkoutKind !== 'git_worktree') {
        throw new Error(`Unsupported Git workspace checkout creation kind: ${checkoutKind}`);
    }

    const created = await createGitWorkspaceCheckoutAtDefaultPath({
        repoRoot: resolveGitRepoRoot(input.context),
        displayName: resolveScmSourceControllerWorkspaceCheckoutCreationDisplayName(input.workspaceCheckoutCreation),
        baseRef: resolveScmSourceControllerWorkspaceCheckoutCreationBaseRef(input.workspaceCheckoutCreation),
    });

    return {
        kind: checkoutKind,
        targetPath: created.targetPath,
    };
}

export async function materializeGitWorkspaceSourceCheckout(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationInput,
): Promise<Readonly<{
    targetPath: string;
}>> {
    const checkoutKind = resolveScmSourceControllerWorkspaceCheckoutMaterializationKind(input.workspaceCheckoutMaterialization);
    if (checkoutKind !== 'git_worktree') {
        throw new Error(`Unsupported Git workspace checkout materialization kind: ${checkoutKind}`);
    }

    return await materializeGitWorkspaceCheckoutAtPath({
        repoRoot: resolveGitRepoRoot(input.context),
        targetPath: resolveScmSourceControllerWorkspaceCheckoutMaterializationTargetPath(input.workspaceCheckoutMaterialization),
        displayName: resolveScmSourceControllerWorkspaceCheckoutMaterializationDisplayName(input.workspaceCheckoutMaterialization),
        baseRef: resolveScmSourceControllerWorkspaceCheckoutMaterializationBaseRef(input.workspaceCheckoutMaterialization),
    });
}

export async function realizeGitWorkspaceCheckout(
    input: ScmSourceControllerWorkspaceCheckoutRealizationInput,
): Promise<ScmSourceControllerWorkspaceCheckoutRealizationResult> {
    const checkoutKind = resolveScmSourceControllerWorkspaceCheckoutRealizationKind(input.workspaceCheckoutRealization);
    if (checkoutKind !== 'git_worktree') {
        throw new Error(`Unsupported Git workspace checkout realization kind: ${checkoutKind}`);
    }

    const targetPath = resolveScmSourceControllerWorkspaceCheckoutRealizationTargetPath(input.workspaceCheckoutRealization);
    if (targetPath) {
        const materialized = await materializeGitWorkspaceCheckoutAtPath({
            repoRoot: resolveGitRepoRoot(input.context),
            targetPath,
            displayName: resolveScmSourceControllerWorkspaceCheckoutRealizationDisplayName(input.workspaceCheckoutRealization),
            baseRef: resolveScmSourceControllerWorkspaceCheckoutRealizationBaseRef(input.workspaceCheckoutRealization),
        });

        return {
            kind: checkoutKind,
            targetPath: materialized.targetPath,
        };
    }

    return await createGitWorkspaceCheckout({
        context: input.context,
        workspaceCheckoutCreation: {
            kind: checkoutKind,
            sourcePath: resolveScmSourceControllerWorkspaceCheckoutRealizationSourcePath(input.workspaceCheckoutRealization),
            displayName: resolveScmSourceControllerWorkspaceCheckoutRealizationDisplayName(input.workspaceCheckoutRealization),
            baseRef: resolveScmSourceControllerWorkspaceCheckoutRealizationBaseRef(input.workspaceCheckoutRealization),
        },
    });
}

export async function resolveGitWorkspaceTransferSourceEntries(input: ScmSourceControllerWorkspaceTransferInput) {
    return await resolveGitWorkspaceTransferEntries(input);
}

export async function resolveGitWorkspaceTransferSourceMetadata(input: ScmSourceControllerWorkspaceTransferInput) {
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
    input: ScmSourceControllerPortableWorkspaceEntriesInput,
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
