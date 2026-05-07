import type {
    ScmHostingProvider,
    ScmPullRequestState,
    ScmPullRequestSummary,
} from '@happier-dev/protocol';
import { parseScmUpstreamRef } from '@happier-dev/protocol';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type PullRequestCreateBlockedReason =
    | 'default_branch_requires_feature'
    | 'default_branch_denied';

export type PullRequestCreateStrategy =
    | Readonly<{
        kind: 'open_or_reuse';
        disabledReason?: 'dirty_unpublished_branch';
    }>
    | { kind: 'run_stacked_create_pr' };

export type PullRequestDefaultBranchAction =
    | Readonly<{
        kind: 'create_feature_branch';
        suggestedBranchName: string;
    }>
    | Readonly<{
        kind: 'create_feature_branch_and_open_pr';
        action: 'createPr';
        suggestedBranchName: string;
    }>;

export type PullRequestUiModel =
    | { kind: 'not_repository' }
    | { kind: 'unknown_provider' }
    | { kind: 'no_branch' }
    | { kind: 'detached_head' }
    | Readonly<{
        kind: 'existing_pull_request';
        provider: ScmHostingProvider;
        pullRequest: ScmPullRequestSummary;
        providerLabel: string;
        repositoryLabel: string;
        numberLabel: string;
        branchLabel: string;
        state: ScmPullRequestState;
    }>
    | Readonly<{
        kind: 'ready_to_create';
        provider: ScmHostingProvider;
        providerLabel: string;
        repositoryLabel: string;
        baseBranch: string;
        headBranch: string;
        canCreatePullRequest: boolean;
        createBlockedReason: PullRequestCreateBlockedReason | null;
        createStrategy: PullRequestCreateStrategy;
        defaultBranchAction: PullRequestDefaultBranchAction | null;
    }>;

export function buildPullRequestUiModel(snapshot: ScmWorkingSnapshot | null): PullRequestUiModel {
    if (!snapshot?.repo.isRepo) {
        return { kind: 'not_repository' };
    }
    if (snapshot.branch.detached) {
        return { kind: 'detached_head' };
    }
    const headBranch = snapshot.branch.head;
    if (!headBranch) {
        return { kind: 'no_branch' };
    }

    const provider = snapshot.hostingProvider ?? null;
    if (!provider || provider.kind === 'unknown' || !provider.nameWithOwner) {
        return { kind: 'unknown_provider' };
    }

    if (snapshot.pullRequest) {
        return {
            kind: 'existing_pull_request',
            provider,
            pullRequest: snapshot.pullRequest,
            providerLabel: provider.name,
            repositoryLabel: provider.nameWithOwner,
            numberLabel: snapshot.pullRequest.number == null ? '' : `#${snapshot.pullRequest.number}`,
            branchLabel: `${snapshot.pullRequest.headBranch} -> ${snapshot.pullRequest.baseBranch}`,
            state: snapshot.pullRequest.state,
        };
    }

    const baseBranch = resolvePullRequestBaseBranch(snapshot, headBranch);
    const createBlockedReason = resolveCreateBlockedReason(snapshot, baseBranch, headBranch);
    return {
        kind: 'ready_to_create',
        provider,
        providerLabel: provider.name,
        repositoryLabel: provider.nameWithOwner,
        baseBranch,
        headBranch,
        canCreatePullRequest: snapshot.capabilities?.writePullRequestCreate === true,
        createBlockedReason,
        createStrategy: resolveCreateStrategy(snapshot),
        defaultBranchAction: resolveDefaultBranchAction({
            snapshot,
            baseBranch,
            headBranch,
            repositoryLabel: provider.nameWithOwner,
            createBlockedReason,
        }),
    };
}

function resolvePullRequestBaseBranch(snapshot: ScmWorkingSnapshot, headBranch: string): string {
    const upstream = parseScmUpstreamRef(snapshot.branch.upstream);
    if (upstream?.branch && upstream.branch !== headBranch) {
        return upstream.branch;
    }

    const defaultBranch = resolveRepositoryDefaultBranch(snapshot);
    if (defaultBranch) {
        return defaultBranch;
    }

    return 'main';
}

function resolveRepositoryDefaultBranch(snapshot: ScmWorkingSnapshot): string | null {
    const defaultWorktree = snapshot.repo.worktrees?.find((worktree) => worktree.isMain === true);
    const branch = defaultWorktree?.branch?.trim();
    return branch ? branch : null;
}

function resolveCreateStrategy(snapshot: ScmWorkingSnapshot): PullRequestCreateStrategy {
    const upstream = parseScmUpstreamRef(snapshot.branch.upstream);
    const upstreamTracksHead = upstream?.branch === snapshot.branch.head;
    if (hasUncommittedChanges(snapshot)) {
        if (!upstreamTracksHead) {
            return {
                kind: 'open_or_reuse',
                disabledReason: 'dirty_unpublished_branch',
            };
        }
        return { kind: 'open_or_reuse' };
    }
    if (snapshot.capabilities?.writePullRequestRunStacked !== true) {
        return { kind: 'open_or_reuse' };
    }
    if (upstreamTracksHead && snapshot.branch.ahead > 0 && snapshot.capabilities?.writeRemotePush === true) {
        return { kind: 'run_stacked_create_pr' };
    }
    if (!upstreamTracksHead && snapshot.capabilities?.writeRemotePublish === true) {
        return { kind: 'run_stacked_create_pr' };
    }
    return { kind: 'open_or_reuse' };
}

function resolveDefaultBranchAction(input: Readonly<{
    snapshot: ScmWorkingSnapshot;
    baseBranch: string;
    headBranch: string;
    repositoryLabel: string;
    createBlockedReason: PullRequestCreateBlockedReason | null;
}>): PullRequestDefaultBranchAction | null {
    if (
        input.headBranch !== input.baseBranch
        || input.createBlockedReason !== 'default_branch_requires_feature'
        || input.snapshot.capabilities?.writeBranchCreate !== true
    ) {
        return null;
    }

    const suggestedBranchName = suggestFeatureBranchName(input.repositoryLabel);
    if (
        input.snapshot.branch.ahead > 0
        && !hasUncommittedChanges(input.snapshot)
        && input.snapshot.capabilities?.writePullRequestRunStacked === true
        && input.snapshot.capabilities?.writeRemotePublish === true
        && input.snapshot.capabilities?.writePullRequestCreate === true
    ) {
        return {
            kind: 'create_feature_branch_and_open_pr',
            action: 'createPr',
            suggestedBranchName,
        };
    }

    return {
        kind: 'create_feature_branch',
        suggestedBranchName,
    };
}

function hasUncommittedChanges(snapshot: ScmWorkingSnapshot): boolean {
    return snapshot.totals.includedFiles > 0
        || snapshot.totals.pendingFiles > 0
        || snapshot.totals.untrackedFiles > 0;
}

function suggestFeatureBranchName(repositoryLabel: string): string {
    const lastSegment = repositoryLabel.split('/').pop() ?? '';
    const slug = lastSegment
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return `feature/${slug || 'changes'}-update`;
}

function resolveCreateBlockedReason(
    snapshot: ScmWorkingSnapshot,
    baseBranch: string,
    headBranch: string,
): PullRequestCreateBlockedReason | null {
    const policy = snapshot.capabilities?.defaultBranchPushPolicy;
    if (policy === 'deny' && headBranch === baseBranch) {
        return 'default_branch_denied';
    }
    if (policy === 'requires-feature-branch' && headBranch === baseBranch) {
        return 'default_branch_requires_feature';
    }
    return null;
}
