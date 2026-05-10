import type {
  ScmHostingProviderRef,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function mapGitlabMergeRequestState(value: unknown): ScmPullRequestState {
  const state = readString(value)?.toLowerCase();
  if (state === 'opened' || state === 'open') return 'open';
  if (state === 'closed') return 'closed';
  if (state === 'merged') return 'merged';
  return 'unknown';
}

export function mapGitlabMergeRequest(
  provider: ScmHostingProviderRef,
  raw: unknown,
  options?: Readonly<{ includeDescription?: boolean }>,
): ScmPullRequestSummary | null {
  if (!isRecord(raw)) return null;

  const number = readPositiveInt(raw.iid);
  const title = readString(raw.title);
  const url = readString(raw.web_url);
  const headBranch = readString(raw.source_branch);
  const baseBranch = readString(raw.target_branch);
  if (!number || !title || !url || !headBranch || !baseBranch) return null;

  const providerNativeId = typeof raw.id === 'number' || typeof raw.id === 'string'
    ? String(raw.id)
    : undefined;
  const description = options?.includeDescription ? readString(raw.description) : null;

  return {
    provider,
    number,
    ...(providerNativeId ? { providerNativeId } : {}),
    title,
    url,
    baseBranch,
    headBranch,
    state: mapGitlabMergeRequestState(raw.state),
    ...(description ? { description } : {}),
  };
}
