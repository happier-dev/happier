import type { ScmHostingProvider, ScmPullRequestState, ScmPullRequestSummary } from '@happier-dev/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInt(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function mapGitlabMergeRequestState(raw: Record<string, unknown>): ScmPullRequestState {
    const state = readString(raw.state)?.toLowerCase();
    if (state === 'opened' || state === 'open') return 'open';
    if (state === 'closed') return 'closed';
    if (state === 'merged') return 'merged';
    return 'unknown';
}

export function mapGitlabMergeRequest(
    provider: ScmHostingProvider,
    raw: unknown,
): ScmPullRequestSummary | null {
    if (!isRecord(raw)) return null;
    const number = readPositiveInt(raw.iid) ?? readPositiveInt(raw.number);
    const title = readString(raw.title);
    const url = readString(raw.web_url) ?? readString(raw.webUrl) ?? readString(raw.url);
    const base = readString(raw.target_branch) ?? readString(raw.targetBranch);
    const head = readString(raw.source_branch) ?? readString(raw.sourceBranch);
    if (!number || !title || !url || !base || !head) return null;
    return {
        provider,
        number,
        title,
        url,
        baseBranch: base,
        headBranch: head,
        state: mapGitlabMergeRequestState(raw),
    };
}
