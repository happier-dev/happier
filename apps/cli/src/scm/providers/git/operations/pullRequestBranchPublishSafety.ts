export type PullRequestBranchPublishPlan =
    | Readonly<{
        kind: 'publish_active_branch';
        branch: string;
        reason: 'missing_upstream' | 'upstream_points_at_base';
    }>
    | Readonly<{
        kind: 'upstream_ok';
        branch: string;
        upstream: string;
    }>;

function normalizeUpstreamBranch(upstream: string | null): string | null {
    if (!upstream) return null;
    const slashIndex = upstream.indexOf('/');
    if (slashIndex < 0) return upstream;
    return upstream.slice(slashIndex + 1) || null;
}

export function resolvePullRequestBranchPublishPlan(input: Readonly<{
    activeBranch: string;
    baseBranch: string;
    upstream: string | null;
}>): PullRequestBranchPublishPlan {
    const activeBranch = input.activeBranch.trim();
    const upstream = input.upstream?.trim() || null;
    if (!upstream) {
        return {
            kind: 'publish_active_branch',
            branch: activeBranch,
            reason: 'missing_upstream',
        };
    }
    if (normalizeUpstreamBranch(upstream) === input.baseBranch.trim()) {
        return {
            kind: 'publish_active_branch',
            branch: activeBranch,
            reason: 'upstream_points_at_base',
        };
    }
    return {
        kind: 'upstream_ok',
        branch: activeBranch,
        upstream,
    };
}
