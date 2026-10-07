import { readGithubAbsoluteWebUrl } from '../locator.js';

import type { GithubOverviewResultV1 } from './contracts.js';

export type GithubPullRequestOverviewV1 = Omit<
  Extract<GithubOverviewResultV1, { kind: 'overview'; kindId: 'pull-request' }>,
  'kind' | 'kindId' | 'observedAtMs'
>;

export type GithubIssueOverviewV1 = Omit<
  Extract<GithubOverviewResultV1, { kind: 'overview'; kindId: 'issue' }>,
  'kind' | 'kindId' | 'observedAtMs'
>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Reads the provider's ordered name/login collection only when it supplied one. */
export function readGithubNamedMembers(
  value: unknown,
  member: string,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return Object.freeze(value.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim().length > 0 ? [entry.trim()] : [];
    if (!isRecord(entry)) return [];
    const name = readTrimmed(entry[member]);
    return name === null ? [] : [name];
  }));
}

function projectCommon(raw: Readonly<Record<string, unknown>>) {
  const title = typeof raw.title === 'string' ? raw.title : null;
  const state = readTrimmed(raw.state);
  const author = isRecord(raw.user) ? readTrimmed(raw.user.login) : null;
  const createdAtMs = readTimestamp(raw.created_at);
  const updatedAtMs = readTimestamp(raw.updated_at);
  const webUrl = readGithubAbsoluteWebUrl(raw.html_url);
  const labels = readGithubNamedMembers(raw.labels, 'name');
  const assignees = readGithubNamedMembers(raw.assignees, 'login');
  const milestone = raw.milestone === null
    ? null
    : isRecord(raw.milestone)
      ? readTrimmed(raw.milestone.title) ?? undefined
      : undefined;
  const body = raw.body === null
    ? null
    : typeof raw.body === 'string'
      ? raw.body
      : undefined;

  return Object.freeze({
    ...(title === null ? {} : { title }),
    ...(state === null ? {} : { state }),
    ...(author === null ? {} : { author }),
    ...(createdAtMs === null ? {} : { createdAtMs }),
    ...(updatedAtMs === null ? {} : { updatedAtMs }),
    ...(body === undefined ? {} : { body }),
    ...(webUrl === null ? {} : { webUrl }),
    ...(labels === null ? {} : { labels }),
    ...(assignees === null ? {} : { assignees }),
    ...(milestone === undefined ? {} : { milestone }),
  });
}

function readRequestedReviewers(
  raw: Readonly<Record<string, unknown>>,
): GithubPullRequestOverviewV1['requestedReviewers'] | null {
  const users = readGithubNamedMembers(raw.requested_reviewers, 'login');
  const teams = readGithubNamedMembers(raw.requested_teams, 'slug');
  if (users === null || teams === null) return null;
  return Object.freeze([
    ...users.map((subject) => Object.freeze({ kind: 'user' as const, subject })),
    ...teams.map((subject) => Object.freeze({ kind: 'team' as const, subject })),
  ]);
}

/** Projects only facts copied from one exact `GET /pulls/{number}` response. */
export function projectGithubPullRequestOverview(
  raw: Readonly<Record<string, unknown>>,
): GithubPullRequestOverviewV1 {
  const head = isRecord(raw.head) ? raw.head : null;
  const base = isRecord(raw.base) ? raw.base : null;
  const headBranch = head === null ? null : readTrimmed(head.ref);
  const baseBranch = base === null ? null : readTrimmed(base.ref);
  const headRevision = head === null ? null : readTrimmed(head.sha);
  const requestedReviewers = readRequestedReviewers(raw);
  const additions = readCount(raw.additions);
  const deletions = readCount(raw.deletions);
  const changedFiles = readCount(raw.changed_files);
  const mergeableState = readTrimmed(raw.mergeable_state);
  const mergedAt = readTrimmed(raw.merged_at);
  const merged = typeof raw.merged === 'boolean'
    ? raw.merged || mergedAt !== null
    : mergedAt === null
      ? undefined
      : true;

  return Object.freeze({
    ...projectCommon(raw),
    ...(typeof raw.draft === 'boolean' ? { draft: raw.draft } : {}),
    ...(merged === undefined ? {} : { merged }),
    ...(headBranch === null ? {} : { headBranch }),
    ...(baseBranch === null ? {} : { baseBranch }),
    ...(requestedReviewers === null ? {} : { requestedReviewers }),
    ...(headRevision === null ? {} : { headRevision }),
    ...(additions === null ? {} : { additions }),
    ...(deletions === null ? {} : { deletions }),
    ...(changedFiles === null ? {} : { changedFiles }),
    branchUpdateEligibility: mergeableState === 'behind'
      ? 'behind'
      : mergeableState === null || mergeableState === 'unknown'
        ? 'unknown'
        : 'not-behind',
  });
}

/** Projects only facts copied from one exact `GET /issues/{number}` response. */
export function projectGithubIssueOverview(
  raw: Readonly<Record<string, unknown>>,
): GithubIssueOverviewV1 {
  return Object.freeze(projectCommon(raw));
}
