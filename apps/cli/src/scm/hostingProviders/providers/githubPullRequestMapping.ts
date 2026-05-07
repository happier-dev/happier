import type { ScmHostingProvider, ScmPullRequestState, ScmPullRequestSummary } from '@happier-dev/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readGithubString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readGithubPositiveInt(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function mapGithubPullState(raw: Record<string, unknown>): ScmPullRequestState {
    if (readGithubString(raw.merged_at) || readGithubString(raw.mergedAt)) return 'merged';
    const state = readGithubString(raw.state)?.toLowerCase();
    if (state === 'open' || state === 'closed' || state === 'merged') return state;
    return 'unknown';
}

export function mapGithubPullRequest(provider: ScmHostingProvider, raw: unknown): ScmPullRequestSummary | null {
    if (!isRecord(raw)) return null;
    const number = readGithubPositiveInt(raw.number);
    const title = readGithubString(raw.title);
    const url = readGithubString(raw.html_url) ?? readGithubString(raw.url);
    const base = isRecord(raw.base)
        ? readGithubString(raw.base.ref)
        : readGithubString(raw.baseRefName);
    const head = isRecord(raw.head)
        ? readGithubString(raw.head.ref)
        : readGithubString(raw.headRefName);
    if (!number || !title || !url || !base || !head) return null;
    return {
        provider,
        number,
        title,
        url,
        baseBranch: base,
        headBranch: head,
        state: mapGithubPullState(raw),
    };
}
