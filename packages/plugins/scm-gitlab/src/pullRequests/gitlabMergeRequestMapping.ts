import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk';

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readProjectId(raw: Record<string, unknown>, snakeKey: string, camelKey: string): number | null {
  return readPositiveInt(raw[snakeKey]) ?? readPositiveInt(raw[camelKey]);
}

function readHeadRepositoryNameWithOwner(provider: ScmHostingProviderRef, raw: Record<string, unknown>): string | null {
  const sourceProjectId = readProjectId(raw, 'source_project_id', 'sourceProjectId');
  const targetProjectId = readProjectId(raw, 'target_project_id', 'targetProjectId');
  const providerNameWithOwner = provider.nameWithOwner?.trim() || null;
  if (providerNameWithOwner && sourceProjectId !== null && sourceProjectId === targetProjectId) {
    return providerNameWithOwner;
  }
  return null;
}

function sameNameWithOwner(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
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
  const headRepositoryNameWithOwner = readHeadRepositoryNameWithOwner(provider, raw);
  const providerNameWithOwner = provider.nameWithOwner?.trim() || null;

  return {
    provider,
    number,
    ...(providerNativeId ? { providerNativeId } : {}),
    title,
    url,
    baseBranch,
    headBranch,
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryNameWithOwner && providerNameWithOwner
      ? { isCrossRepository: !sameNameWithOwner(headRepositoryNameWithOwner, providerNameWithOwner) }
      : {}),
    state: mapGitlabMergeRequestState(raw.state),
    ...(description ? { description } : {}),
  };
}
