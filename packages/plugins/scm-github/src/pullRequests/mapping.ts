import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestChecksState,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import { readGithubCheckOutcomeV1, readGithubStatusContextObservationV1 } from '../triage/checkOutcome.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readGithubString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readGithubPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readGithubBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNestedString(value: unknown, key: string): string | null {
  return isRecord(value) ? readGithubString(value[key]) : null;
}

function readGithubNameWithOwner(value: unknown): string | null {
  const raw = readGithubString(value);
  if (!raw) return null;
  const segments = raw.split('/');
  if (segments.length !== 2) return null;
  const owner = segments[0]?.trim();
  const name = segments[1]?.trim();
  return owner && name ? `${owner}/${name}` : null;
}

function readGithubRepositoryNameWithOwner(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = readGithubNameWithOwner(value.nameWithOwner)
    ?? readGithubNameWithOwner(value.full_name)
    ?? readGithubNameWithOwner(value.fullName);
  if (direct) return direct;
  const name = readGithubString(value.name);
  const owner = isRecord(value.owner)
    ? readGithubString(value.owner.login) ?? readGithubString(value.owner.name)
    : null;
  return owner && name ? `${owner}/${name}` : null;
}

function readGithubHeadRepositoryNameWithOwner(raw: Record<string, unknown>): string | null {
  const restHeadRepository = isRecord(raw.head) ? readGithubRepositoryNameWithOwner(raw.head.repo) : null;
  if (restHeadRepository) return restHeadRepository;
  const cliHeadRepository = readGithubRepositoryNameWithOwner(raw.headRepository);
  if (cliHeadRepository) return cliHeadRepository;
  const cliHeadRepositoryOwner = isRecord(raw.headRepositoryOwner)
    ? readGithubString(raw.headRepositoryOwner.login) ?? readGithubString(raw.headRepositoryOwner.name)
    : null;
  const cliHeadRepositoryName = isRecord(raw.headRepository)
    ? readGithubString(raw.headRepository.name)
    : null;
  return cliHeadRepositoryOwner && cliHeadRepositoryName
    ? `${cliHeadRepositoryOwner}/${cliHeadRepositoryName}`
    : null;
}

function sameNameWithOwner(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function readGithubPullRequestState(value: unknown): ScmPullRequestState {
  if (!isRecord(value)) return 'unknown';
  const raw = value;
  const mergedAtMs = parseTimestampMs(raw.merged_at) ?? parseTimestampMs(raw.mergedAt);
  const state = readGithubString(raw.state)?.toLowerCase();
  if (readGithubBoolean(raw.merged) === true || state === 'merged' || mergedAtMs !== null) return 'merged';
  if (state === 'closed') return 'closed';
  if (state === 'open' || state === 'draft') {
    return state === 'draft' || readGithubBoolean(raw.draft) === true || readGithubBoolean(raw.isDraft) === true ? 'draft' : 'open';
  }
  return 'unknown';
}

function mapGithubAuthor(raw: Record<string, unknown>): ScmPullRequestSummary['author'] | undefined {
  const source = isRecord(raw.user) ? raw.user : isRecord(raw.author) ? raw.author : null;
  if (!source) return undefined;
  const login = readGithubString(source.login);
  const displayName = readGithubString(source.name) ?? readGithubString(source.displayName);
  const url = readGithubString(source.html_url) ?? readGithubString(source.url);
  if (!login && !displayName && !url) return undefined;
  return {
    ...(login ? { login } : {}),
    ...(displayName ? { displayName } : {}),
    ...(url ? { url } : {}),
  };
}

function mapGithubChecks(raw: Record<string, unknown>): ScmPullRequestSummary['checks'] | undefined {
  const rollup = raw.statusCheckRollup;
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  const outcomes = rollup.map((entry) => {
    if (!isRecord(entry)) return 'unknown';
    if (entry.__typename === 'StatusContext') {
      return readGithubCheckOutcomeV1(readGithubStatusContextObservationV1(readGithubString(entry.state)));
    }
    const status = readGithubString(entry.status)?.toLowerCase();
    return status === undefined ? 'unknown' : readGithubCheckOutcomeV1({ status, conclusion: readGithubString(entry.conclusion)?.toLowerCase() ?? null });
  });
  let state: ScmPullRequestChecksState = 'unknown';
  if (outcomes.includes('failed')) {
    state = 'failure';
  } else if (outcomes.includes('pending')) {
    state = 'pending';
  } else if (outcomes.every((outcome) => outcome === 'passed' || outcome === 'neutral')) {
    state = 'success';
  }
  return { state };
}

export function mapGithubPullRequest(
  provider: ScmHostingProviderRef,
  raw: unknown,
): ScmPullRequestSummary | null {
  if (!isRecord(raw)) return null;

  const number = readGithubPositiveInt(raw.number);
  const title = readGithubString(raw.title);
  const url = readGithubString(raw.html_url) ?? readGithubString(raw.url);
  const baseBranch = readNestedString(raw.base, 'ref') ?? readGithubString(raw.baseRefName);
  const headBranch = readNestedString(raw.head, 'ref') ?? readGithubString(raw.headRefName);
  if (!number || !title || !url || !baseBranch || !headBranch) return null;

  const providerNativeId = typeof raw.id === 'number' || typeof raw.id === 'string'
    ? String(raw.id)
    : undefined;
  const baseSha = readNestedString(raw.base, 'sha') ?? readGithubString(raw.baseRefOid);
  const headSha = readNestedString(raw.head, 'sha') ?? readGithubString(raw.headRefOid);
  const headRepositoryNameWithOwner = readGithubHeadRepositoryNameWithOwner(raw);
  const providerNameWithOwner = provider.nameWithOwner?.trim() || null;
  const isDraft = readGithubBoolean(raw.draft) ?? readGithubBoolean(raw.isDraft) ?? undefined;
  const author = mapGithubAuthor(raw);
  const checks = mapGithubChecks(raw);
  const createdAtMs = parseTimestampMs(raw.created_at) ?? parseTimestampMs(raw.createdAt);
  const closedAtMs = parseTimestampMs(raw.closed_at) ?? parseTimestampMs(raw.closedAt);
  const mergedAtMs = parseTimestampMs(raw.merged_at) ?? parseTimestampMs(raw.mergedAt);

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
    ...(headSha !== null ? { headSha } : {}),
    ...(baseSha !== null ? { baseSha } : {}),
    state: readGithubPullRequestState(raw),
    ...(createdAtMs !== null ? { createdAtMs } : {}),
    ...(closedAtMs !== null ? { closedAtMs } : {}),
    ...(mergedAtMs !== null ? { mergedAtMs } : {}),
    ...(typeof isDraft === 'boolean' ? { isDraft } : {}),
    ...(author ? { author } : {}),
    ...(checks ? { checks } : {}),
  };
}
