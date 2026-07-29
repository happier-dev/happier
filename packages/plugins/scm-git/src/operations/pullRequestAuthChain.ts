import {
  SCM_OPERATION_ERROR_CODES,
  type ScmHostingProviderRef,
  type ScmPullRequestReference,
  type ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';

export type BranchHeadContext = Readonly<{
    provider: ScmHostingProviderRef;
    baseBranch: string;
    headBranch: string;
    headRepositoryNameWithOwner?: string;
}>;

export type DuplicatePullRequestHint =
    | Readonly<{
        kind: 'pullRequest';
        pullRequest: ScmPullRequestSummary;
    }>
    | Readonly<{
        kind: 'reference';
        reference: ScmPullRequestReference;
    }>;

function readStringField(value: unknown, key: string): string | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const field = record[key];
    return typeof field === 'string' && field.trim() ? field.trim() : null;
}

function readNumberField(value: unknown, key: string): number | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const field = record[key];
    return typeof field === 'number' && Number.isInteger(field) && field > 0 ? field : null;
}

function isPullRequestSummary(value: unknown): value is ScmPullRequestSummary {
    return Boolean(
        value
        && typeof value === 'object'
        && readStringField(value, 'url')
        && readStringField(value, 'baseBranch')
        && readStringField(value, 'headBranch')
        && readStringField(value, 'title')
    );
}

function readFirstUrl(value: string): string | null {
    return value.split(/\s+/).find((part) => {
        try {
            const parsed = new URL(part.replace(/[),.;]+$/u, ''));
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch {
            return false;
        }
    })?.replace(/[),.;]+$/u, '') ?? null;
}

function isDuplicateConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { errorCode?: unknown }).errorCode;
    if (code === SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS) return true;
    const kind = readStringField(error, 'kind') ?? readStringField(error, 'code');
    return kind === 'duplicate_pull_request' || kind === 'pull_request_already_exists';
}

export function readDuplicatePullRequestHint(error: unknown): DuplicatePullRequestHint | null {
    if (!isDuplicateConflict(error)) return null;
    if (isPullRequestSummary((error as { pullRequest?: unknown }).pullRequest)) {
        return {
            kind: 'pullRequest',
            pullRequest: (error as { pullRequest: ScmPullRequestSummary }).pullRequest,
        };
    }
    if (isPullRequestSummary((error as { existingPullRequest?: unknown }).existingPullRequest)) {
        return {
            kind: 'pullRequest',
            pullRequest: (error as { existingPullRequest: ScmPullRequestSummary }).existingPullRequest,
        };
    }
    const number = readNumberField(error, 'pullRequestNumber') ?? readNumberField(error, 'number');
    if (number !== null) {
        return {
            kind: 'reference',
            reference: { number },
        };
    }
    const explicitUrl = readStringField(error, 'pullRequestUrl') ?? readStringField(error, 'url');
    const messageUrl = error instanceof Error ? readFirstUrl(error.message) : null;
    const url = explicitUrl ?? messageUrl;
    if (url) {
        return {
            kind: 'reference',
            reference: { url },
        };
    }
    return null;
}

function sameProvider(left: ScmHostingProviderRef, right: ScmHostingProviderRef): boolean {
    return left.id === right.id
        && left.kind === right.kind
        && left.baseUrl === right.baseUrl
        && (left.nameWithOwner ?? '') === (right.nameWithOwner ?? '');
}

function readHeadRepositoryNameWithOwner(pullRequest: ScmPullRequestSummary): string | null {
    const direct = readStringField(pullRequest, 'headRepositoryNameWithOwner');
    if (direct) return direct;
    const repository = (pullRequest as { headRepository?: unknown }).headRepository;
    return readStringField(repository, 'nameWithOwner');
}

function normalizeNameWithOwner(value: string | null | undefined): string | null {
    const normalized = value?.trim().toLowerCase() ?? '';
    if (!normalized) return null;
    const segments = normalized.split('/');
    return segments.length >= 2 && segments.every((segment) => segment.length > 0) ? normalized : null;
}

export function matchesBranchHeadContext(input: Readonly<{
    pullRequest: ScmPullRequestSummary;
    provider: ScmHostingProviderRef;
    baseBranch: string;
    headBranch: string;
    headRepositoryNameWithOwner?: string;
}>): boolean {
    if (!sameProvider(input.pullRequest.provider, input.provider)) return false;
    if (input.pullRequest.state !== 'open') return false;
    if (input.pullRequest.baseBranch !== input.baseBranch) return false;
    if (input.pullRequest.headBranch !== input.headBranch) return false;
    const expectedHeadRepository = normalizeNameWithOwner(
        input.headRepositoryNameWithOwner ?? input.provider.nameWithOwner,
    );
    const actualHeadRepository = normalizeNameWithOwner(readHeadRepositoryNameWithOwner(input.pullRequest));
    return Boolean(expectedHeadRepository && actualHeadRepository && actualHeadRepository === expectedHeadRepository);
}
