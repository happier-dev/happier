import type {
  ScmHostingProviderRef,
  ScmHostingRepositorySummary,
  ScmHostingRepositoryVisibility,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import {
  buildBitbucketRepositoryWebUrl,
  readBitbucketRepositoryCoordinates,
} from '../parsing/bitbucketCoordinates.js';

export type BitbucketPullRequestListDecodeResult = Readonly<{
  pullRequests: readonly ScmPullRequestSummary[];
  diagnostics: readonly string[];
}>;

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNestedRecord(source: unknown, key: string): Record<string, unknown> | null {
  return isRecord(source) && isRecord(source[key]) ? source[key] as Record<string, unknown> : null;
}

function readNestedString(source: unknown, ...keys: readonly string[]): string | null {
  let current: unknown = source;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return readString(current);
}

function readNameWithOwner(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const segments = raw.split('/').map((segment) => segment.trim());
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return `${segments[0]}/${segments[1]}`;
}

function sameNameWithOwner(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function mapBitbucketState(raw: Record<string, unknown>): ScmPullRequestState {
  const state = readString(raw.state)?.toUpperCase();
  if (readString(raw.draft) === 'true' || raw.draft === true) return 'draft';
  if (state === 'OPEN') return 'open';
  if (state === 'MERGED') return 'merged';
  if (state === 'DECLINED' || state === 'SUPERSEDED') return 'closed';
  return 'unknown';
}

function readBitbucketAuthor(raw: Record<string, unknown>): ScmPullRequestSummary['author'] | undefined {
  const author = readNestedRecord(raw, 'author');
  if (!author) return undefined;
  const login = readString(author.nickname) ?? readString(author.username) ?? readString(author.account_id);
  const displayName = readString(author.display_name) ?? readString(author.displayName);
  const url = readNestedString(author, 'links', 'html', 'href');
  if (!login && !displayName && !url) return undefined;
  return {
    ...(login ? { login } : {}),
    ...(displayName ? { displayName } : {}),
    ...(url ? { url } : {}),
  };
}

export function mapBitbucketPullRequest(
  provider: ScmHostingProviderRef,
  raw: unknown,
): ScmPullRequestSummary | null {
  if (!isRecord(raw)) return null;
  const number = readPositiveInt(raw.id);
  const title = readString(raw.title);
  const url = readNestedString(raw, 'links', 'html', 'href') ?? readString(raw.url);
  const baseBranch = readNestedString(raw, 'destination', 'branch', 'name');
  const headBranch = readNestedString(raw, 'source', 'branch', 'name');
  if (!number || !title || !url || !baseBranch || !headBranch) return null;

  const source = readNestedRecord(raw, 'source');
  const sourceRepository = readNestedRecord(source, 'repository');
  const headRepositoryNameWithOwner = sourceRepository
    ? readNameWithOwner(sourceRepository.full_name) ?? readNameWithOwner(sourceRepository.nameWithOwner)
    : null;
  if (sourceRepository && !headRepositoryNameWithOwner) return null;
  const providerNameWithOwner = provider.nameWithOwner?.trim();
  const baseSha = readNestedString(raw, 'destination', 'commit', 'hash');
  const headSha = readNestedString(raw, 'source', 'commit', 'hash');
  const isDraft = typeof raw.draft === 'boolean' ? raw.draft : undefined;
  const author = readBitbucketAuthor(raw);

  return {
    provider,
    number,
    providerNativeId: String(number),
    title,
    url,
    baseBranch,
    headBranch,
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryNameWithOwner && providerNameWithOwner
      ? { isCrossRepository: !sameNameWithOwner(headRepositoryNameWithOwner, providerNameWithOwner) }
      : {}),
    ...(headSha !== null ? { headSha } : {}),
    ...(baseSha !== null ? { baseSha } : {}),
    state: mapBitbucketState(raw),
    ...(typeof isDraft === 'boolean' ? { isDraft } : {}),
    ...(author ? { author } : {}),
  };
}

export function decodeBitbucketPullRequestList(
  provider: ScmHostingProviderRef,
  raw: unknown,
): BitbucketPullRequestListDecodeResult {
  const values = isRecord(raw) && Array.isArray(raw.values)
    ? raw.values
    : Array.isArray(raw) ? raw : [];
  const pullRequests: ScmPullRequestSummary[] = [];
  const diagnostics: string[] = [];
  values.forEach((value, index) => {
    const mapped = mapBitbucketPullRequest(provider, value);
    if (mapped) {
      pullRequests.push(mapped);
    } else {
      diagnostics.push(`Skipped malformed Bitbucket pull request row at index ${index}`);
    }
  });
  return { pullRequests, diagnostics };
}

function readCloneUrl(raw: unknown, kind: 'https' | 'ssh'): string | null {
  const cloneLinks = readNestedRecord(raw, 'links')?.clone;
  if (!Array.isArray(cloneLinks)) return null;
  for (const link of cloneLinks) {
    if (!isRecord(link)) continue;
    if (readString(link.name)?.toLowerCase() === kind) {
      const href = readString(link.href);
      if (href) return href;
    }
  }
  return null;
}

function visibilityFromRaw(
  raw: Record<string, unknown>,
  fallback: ScmHostingRepositoryVisibility,
): ScmHostingRepositoryVisibility {
  if (typeof raw.is_private === 'boolean') return raw.is_private ? 'private' : 'public';
  return fallback;
}

export function mapBitbucketRepositorySummary(input: Readonly<{
  provider: ScmHostingProviderRef;
  raw: unknown;
  owner: string;
  repositoryName: string;
  visibility?: ScmHostingRepositoryVisibility;
}>): ScmHostingRepositorySummary | null {
  if (!isRecord(input.raw)) return null;
  const coordinates = readBitbucketRepositoryCoordinates(input.provider);
  const nameWithOwner = readString(input.raw.full_name)
    ?? `${input.owner}/${input.repositoryName}`;
  const repositoryName = nameWithOwner.split('/')[1] ?? input.repositoryName;
  const webUrl = readNestedString(input.raw, 'links', 'html', 'href')
    ?? buildBitbucketRepositoryWebUrl({
      provider: input.provider,
      nameWithOwner,
    });
  const cloneUrl = readCloneUrl(input.raw, 'https');
  const sshUrl = readCloneUrl(input.raw, 'ssh');
  const defaultBranch = readNestedString(input.raw, 'mainbranch', 'name');

  return {
    provider: {
      ...input.provider,
      nameWithOwner,
    },
    nameWithOwner,
    webUrl,
    ...(cloneUrl ? { cloneUrl } : {}),
    ...(sshUrl ? { sshUrl } : {}),
    visibility: visibilityFromRaw(input.raw, input.visibility ?? 'private'),
    defaultBranch: defaultBranch ?? null,
    repositoryName,
    workspace: coordinates.workspace,
  };
}

export function resolveBitbucketCheckoutReferenceFromPullRequest(
  pullRequest: ScmPullRequestSummary,
) {
  return {
    pullRequest,
    branch: pullRequest.headBranch,
    ...(pullRequest.headSha !== undefined ? { headSha: pullRequest.headSha } : {}),
    ...(pullRequest.baseSha !== undefined ? { baseSha: pullRequest.baseSha } : {}),
  };
}
