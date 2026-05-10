import type { ScmFollowupAction } from '@happier-dev/protocol';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { validateScmFollowupOpenUrl } from './validateScmFollowupOpenUrl';

export type SourceControlPullRequestAction =
    | Readonly<{ kind: 'open-url'; followup: Extract<ScmFollowupAction, { kind: 'openUrl' }>; disabled: boolean }>
    | Readonly<{ kind: 'open-or-reuse'; baseBranch: string; headBranch: string; disabled: boolean }>
    | Readonly<{ kind: 'open-compose'; baseBranch: string; headBranch: string; disabled: boolean }>;

export type SourceControlPullRequestViewModel = Readonly<{
    kind: 'unavailable' | 'existing' | 'create';
    baseBranch: string | null;
    headBranch: string | null;
    title: string | null;
    state: string | null;
    blockedReason: 'not-repository' | 'missing-branch' | 'missing-base' | 'unsupported' | 'unsafe-url' | null;
    primaryAction: SourceControlPullRequestAction | null;
    secondaryAction: SourceControlPullRequestAction | null;
}>;

export function resolveSourceControlPullRequestViewModel(input: Readonly<{
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
}>): SourceControlPullRequestViewModel {
    const snapshot = input.snapshot;
    if (!snapshot?.repo.isRepo) {
        return {
            kind: 'unavailable',
            baseBranch: null,
            headBranch: null,
            title: null,
            state: null,
            blockedReason: 'not-repository',
            primaryAction: null,
            secondaryAction: null,
        };
    }

    const prStatus = snapshot.pullRequestStatus ?? null;
    const openPullRequest = prStatus?.openPullRequest ?? null;
    const baseBranch = prStatus?.baseBranch ?? snapshot.repo.defaultBranch ?? null;
    const headBranch = prStatus?.headBranch ?? snapshot.branch.head ?? null;
    const disabled = input.disabled === true;

    if (openPullRequest) {
        const followup = {
            kind: 'openUrl',
            purpose: 'pullRequest',
            url: openPullRequest.url,
            allowedBaseUrl: openPullRequest.provider.baseUrl,
            urlSafety: openPullRequest.provider.urlSafety,
        } as const;
        const safe = validateScmFollowupOpenUrl(followup);
        return {
            kind: 'existing',
            baseBranch: openPullRequest.baseBranch,
            headBranch: openPullRequest.headBranch,
            title: openPullRequest.title,
            state: openPullRequest.state,
            blockedReason: safe.ok ? null : 'unsafe-url',
            primaryAction: {
                kind: 'open-url',
                followup,
                disabled: disabled || !safe.ok,
            },
            secondaryAction: null,
        };
    }

    if (!headBranch) {
        return {
            kind: 'unavailable',
            baseBranch,
            headBranch: null,
            title: null,
            state: null,
            blockedReason: 'missing-branch',
            primaryAction: null,
            secondaryAction: null,
        };
    }
    if (!baseBranch) {
        return {
            kind: 'unavailable',
            baseBranch: null,
            headBranch,
            title: null,
            state: null,
            blockedReason: 'missing-base',
            primaryAction: null,
            secondaryAction: null,
        };
    }
    if (snapshot.capabilities?.writePullRequestCreate !== true) {
        return {
            kind: 'unavailable',
            baseBranch,
            headBranch,
            title: null,
            state: null,
            blockedReason: 'unsupported',
            primaryAction: null,
            secondaryAction: null,
        };
    }

    return {
        kind: 'create',
        baseBranch,
        headBranch,
        title: null,
        state: null,
        blockedReason: null,
        primaryAction: {
            kind: 'open-or-reuse',
            baseBranch,
            headBranch,
            disabled,
        },
        secondaryAction: null,
    };
}
