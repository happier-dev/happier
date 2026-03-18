import type { ScmSourceControllerWorkspaceTransferInput } from '../../types';

import { inspectGitCheckoutIdentity } from './checkoutIdentity';

export type GitWorkspaceTransferMetadata = Readonly<{
    provider: 'git';
}> & (
    Readonly<{
        checkoutKind: 'branch';
        branchName: string;
        headRevision?: string;
    }>
    | Readonly<{
        checkoutKind: 'detached';
        headRevision: string;
    }>
);

export function isGitWorkspaceTransferMetadata(value: unknown): value is GitWorkspaceTransferMetadata {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<GitWorkspaceTransferMetadata> & {
        checkoutKind?: string;
        branchName?: string;
        headRevision?: string;
    };
    if (candidate.provider !== 'git') {
        return false;
    }

    if (candidate.checkoutKind === 'branch') {
        return typeof candidate.branchName === 'string'
            && candidate.branchName.trim().length > 0
            && (candidate.headRevision == null || /^[0-9a-f]{40}$/i.test(candidate.headRevision));
    }

    if (candidate.checkoutKind === 'detached') {
        return typeof candidate.headRevision === 'string'
            && /^[0-9a-f]{40}$/i.test(candidate.headRevision);
    }

    return false;
}

export async function resolveGitWorkspaceTransferMetadata(
    input: ScmSourceControllerWorkspaceTransferInput,
): Promise<GitWorkspaceTransferMetadata | null> {
    const identity = await inspectGitCheckoutIdentity({ cwd: input.context.cwd });
    if (!identity?.headRevision && !identity?.branchName) {
        return null;
    }

    if (!identity.branchName) {
        if (!identity.headRevision) {
            return null;
        }

        return {
            provider: 'git',
            checkoutKind: 'detached',
            headRevision: identity.headRevision,
        };
    }

    return {
        provider: 'git',
        checkoutKind: 'branch',
        branchName: identity.branchName,
        ...(identity.headRevision ? { headRevision: identity.headRevision } : {}),
    };
}
