/**
 * GitHub REST response fixtures for the Triage vertical.
 *
 * PROVENANCE: field sets reproduced from GitHub's published REST API documentation and
 * its machine-readable OpenAPI description (`github/rest-api-description`,
 * `descriptions/api.github.com`) as consulted on 2026-08-14 for API version
 * `2026-03-10`. They are SHAPE fixtures: every identifier, login, repository, title,
 * body and URL below is synthetic. No live account was called, and no credential,
 * token, cookie, organization identifier or personal detail appears here.
 *
 * Where GitHub documents a field as optional or context-dependent, the fixture that
 * exercises the missing case omits it rather than substituting a default — the missing
 * case is the one that breaks a naive decoder.
 */

type JsonRecord = Readonly<Record<string, unknown>>;

const OWNER = 'octo-org';
const REPOSITORY = 'example-app';
const REPOSITORY_ID = 4210;
const OTHER_REPOSITORY = 'example-tools';
const OTHER_REPOSITORY_ID = 8815;

export const GITHUB_FIXTURE_OWNER = OWNER;
export const GITHUB_FIXTURE_REPOSITORY = REPOSITORY;
export const GITHUB_FIXTURE_REPOSITORY_ID = String(REPOSITORY_ID);
export const GITHUB_FIXTURE_OTHER_REPOSITORY = OTHER_REPOSITORY;
export const GITHUB_FIXTURE_OTHER_REPOSITORY_ID = String(OTHER_REPOSITORY_ID);

function repositoryObject(input: Readonly<{
  id: number;
  owner: string;
  name: string;
}>): JsonRecord {
  return Object.freeze({
    id: input.id,
    node_id: 'R_kgDOsynthetic',
    name: input.name,
    full_name: `${input.owner}/${input.name}`,
    private: false,
    owner: Object.freeze({ login: input.owner, id: 991, type: 'Organization' }),
    html_url: `https://github.com/${input.owner}/${input.name}`,
    url: `https://api.github.com/repos/${input.owner}/${input.name}`,
    archived: false,
    default_branch: 'main',
  });
}

export const GITHUB_REPOSITORY_RESPONSE: JsonRecord = repositoryObject({
  id: REPOSITORY_ID,
  owner: OWNER,
  name: REPOSITORY,
});

export const GITHUB_OTHER_REPOSITORY_RESPONSE: JsonRecord = repositoryObject({
  id: OTHER_REPOSITORY_ID,
  owner: OWNER,
  name: OTHER_REPOSITORY,
});

function simpleUser(login: string, id: number): JsonRecord {
  return Object.freeze({
    login,
    id,
    node_id: 'U_kgDOsynthetic',
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    html_url: `https://github.com/${login}`,
    type: 'User',
  });
}

export const GITHUB_SEARCH_PULL_REQUEST_ITEM: JsonRecord = Object.freeze({
  url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/issues/1284`,
  repository_url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}`,
  html_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284`,
  id: 2_301_884_991,
  node_id: 'PR_kwDOsynthetic',
  number: 1284,
  title: 'Stream terminal frames without a full re-render',
  user: simpleUser('octocat', 583_231),
  labels: Object.freeze([
    Object.freeze({ id: 11, name: 'performance', color: 'd4c5f9', default: false }),
    Object.freeze({ id: 12, name: 'terminal', color: '0e8a16', default: false }),
    Object.freeze({ id: 13, name: 'needs-review', color: 'fbca04', default: false }),
    Object.freeze({ id: 14, name: 'v2', color: 'c2e0c6', default: false }),
    Object.freeze({ id: 15, name: 'client', color: 'bfdadc', default: false }),
  ]),
  state: 'open',
  locked: false,
  assignees: Object.freeze([simpleUser('hubot', 583_232)]),
  comments: 7,
  created_at: '2026-08-01T09:14:22Z',
  updated_at: '2026-08-12T18:03:40Z',
  closed_at: null,
  author_association: 'MEMBER',
  draft: false,
  pull_request: Object.freeze({
    url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/pulls/1284`,
    html_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284`,
    diff_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284.diff`,
    patch_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284.patch`,
    merged_at: null,
  }),
  body: '  Reworks the frame pump so a  long output burst\n\n  does not force a full re-render.  ',
  score: 1,
  repository: repositoryObject({ id: REPOSITORY_ID, owner: OWNER, name: REPOSITORY }),
});

/**
 * GitHub documents `repository` as an item field, but it is optional in the schema.
 * When it is absent the row carries only the mutable `repository_url` path, and identity
 * has to come from a separate repository read — the case that silently drops every row
 * if a client assumes the id is always there.
 */
export const GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY: JsonRecord = Object.freeze(
  Object.fromEntries(
    Object.entries(GITHUB_SEARCH_PULL_REQUEST_ITEM).filter(([key]) => key !== 'repository'),
  ),
);

export const GITHUB_SEARCH_ISSUE_ITEM: JsonRecord = Object.freeze({
  url: `https://api.github.com/repos/${OWNER}/${OTHER_REPOSITORY}/issues/7`,
  repository_url: `https://api.github.com/repos/${OWNER}/${OTHER_REPOSITORY}`,
  html_url: `https://github.com/${OWNER}/${OTHER_REPOSITORY}/issues/7`,
  id: 2_299_100_004,
  node_id: 'I_kwDOsynthetic',
  number: 7,
  title: 'Reconnect loop after a laptop resume',
  user: simpleUser('monalisa', 583_233),
  labels: Object.freeze([]),
  state: 'open',
  state_reason: null,
  locked: false,
  assignees: Object.freeze([]),
  comments: 0,
  created_at: '2026-07-28T11:00:00Z',
  updated_at: '2026-08-11T07:42:10Z',
  closed_at: null,
  author_association: 'CONTRIBUTOR',
  body: null,
  score: 1,
  repository: repositoryObject({
    id: OTHER_REPOSITORY_ID,
    owner: OWNER,
    name: OTHER_REPOSITORY,
  }),
});

/** A row whose `number` is missing: the shape that must be omitted, not fabricated. */
export const GITHUB_SEARCH_UNDECODABLE_ITEM: JsonRecord = Object.freeze({
  url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/issues/0`,
  repository_url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}`,
  html_url: `https://github.com/${OWNER}/${REPOSITORY}/issues/0`,
  id: 2_299_100_005,
  title: 'A row with no usable number',
  state: 'open',
  created_at: '2026-07-28T11:00:00Z',
  updated_at: '2026-08-11T07:42:10Z',
});

export function githubSearchResponse(input: Readonly<{
  items: readonly JsonRecord[];
  totalCount?: number;
  incompleteResults?: boolean;
}>): JsonRecord {
  return Object.freeze({
    total_count: input.totalCount ?? input.items.length,
    incomplete_results: input.incompleteResults ?? false,
    /** Additive fields GitHub now returns; a strict envelope must ignore them. */
    search_type: 'lexical',
    items: Object.freeze([...input.items]),
  });
}

export const GITHUB_PULL_REQUEST_RESPONSE: JsonRecord = Object.freeze({
  url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/pulls/1284`,
  id: 2_301_884_991,
  node_id: 'PR_kwDOsynthetic',
  html_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284`,
  number: 1284,
  state: 'open',
  locked: false,
  title: 'Stream terminal frames without a full re-render',
  user: simpleUser('octocat', 583_231),
  body: 'Reworks the frame pump.',
  created_at: '2026-08-01T09:14:22Z',
  updated_at: '2026-08-12T18:03:40Z',
  closed_at: null,
  merged_at: null,
  merge_commit_sha: null,
  draft: false,
  labels: Object.freeze([Object.freeze({ id: 11, name: 'performance' })]),
  head: Object.freeze({
    label: `${OWNER}:frame-pump`,
    ref: 'frame-pump',
    sha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    repo: repositoryObject({ id: REPOSITORY_ID, owner: OWNER, name: REPOSITORY }),
  }),
  base: Object.freeze({
    label: `${OWNER}:main`,
    ref: 'main',
    sha: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
    repo: repositoryObject({ id: REPOSITORY_ID, owner: OWNER, name: REPOSITORY }),
  }),
  merged: false,
  mergeable: true,
  rebaseable: true,
  mergeable_state: 'clean',
  comments: 7,
  review_comments: 4,
  commits: 6,
  additions: 214,
  deletions: 88,
  changed_files: 12,
});

export const GITHUB_ISSUE_RESPONSE: JsonRecord = Object.freeze({
  url: `https://api.github.com/repos/${OWNER}/${OTHER_REPOSITORY}/issues/7`,
  repository_url: `https://api.github.com/repos/${OWNER}/${OTHER_REPOSITORY}`,
  html_url: `https://github.com/${OWNER}/${OTHER_REPOSITORY}/issues/7`,
  id: 2_299_100_004,
  node_id: 'I_kwDOsynthetic',
  number: 7,
  title: 'Reconnect loop after a laptop resume',
  user: simpleUser('monalisa', 583_233),
  labels: Object.freeze([]),
  state: 'open',
  state_reason: null,
  locked: false,
  comments: 3,
  created_at: '2026-07-28T11:00:00Z',
  updated_at: '2026-08-11T07:42:10Z',
  closed_at: null,
  author_association: 'CONTRIBUTOR',
  body: 'The client reconnects in a loop after resume.',
});

/** The destination an issue transfer redirects to: a different repository AND number. */
export const GITHUB_TRANSFERRED_ISSUE_RESPONSE: JsonRecord = Object.freeze({
  url: `https://api.github.com/repos/${OWNER}/${OTHER_REPOSITORY}/issues/41`,
  repository_url: `https://api.github.com/repos/${OWNER}/${OTHER_REPOSITORY}`,
  html_url: `https://github.com/${OWNER}/${OTHER_REPOSITORY}/issues/41`,
  id: 2_299_100_777,
  node_id: 'I_kwDOsynthetic2',
  number: 41,
  title: 'Reconnect loop after a laptop resume',
  user: simpleUser('monalisa', 583_233),
  labels: Object.freeze([]),
  state: 'open',
  state_reason: null,
  comments: 3,
  created_at: '2026-07-28T11:00:00Z',
  updated_at: '2026-08-13T08:00:00Z',
  body: 'The client reconnects in a loop after resume.',
});

export function githubCheckRunsResponse(input: Readonly<{
  runs: readonly JsonRecord[];
  totalCount?: number;
}>): JsonRecord {
  return Object.freeze({
    total_count: input.totalCount ?? input.runs.length,
    check_runs: Object.freeze([...input.runs]),
  });
}

export function githubCheckRun(input: Readonly<{
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion?: string | null;
  output?: Readonly<{ title?: string | null; summary?: string | null; text?: string | null }>;
}>): JsonRecord {
  return Object.freeze({
    id: input.id,
    node_id: 'CR_kwDOsynthetic',
    name: input.name,
    head_sha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    status: input.status,
    conclusion: input.conclusion ?? null,
    started_at: '2026-08-12T18:00:00Z',
    completed_at: input.status === 'completed' ? '2026-08-12T18:04:00Z' : null,
    /** Matrix legs legitimately share a name and a details URL. */
    details_url: `https://ci.example.com/${OWNER}/${REPOSITORY}/checks`,
    html_url: `https://github.com/${OWNER}/${REPOSITORY}/runs/${input.id}`,
    output: Object.freeze({
      title: input.output?.title ?? null,
      summary: input.output?.summary ?? null,
      text: input.output?.text ?? null,
      annotations_count: 0,
    }),
  });
}

export function githubCombinedStatusResponse(input: Readonly<{
  state: 'success' | 'pending' | 'failure' | 'error';
  statuses: readonly JsonRecord[];
}>): JsonRecord {
  return Object.freeze({
    state: input.state,
    total_count: input.statuses.length,
    sha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    statuses: Object.freeze([...input.statuses]),
    repository: repositoryObject({ id: REPOSITORY_ID, owner: OWNER, name: REPOSITORY }),
  });
}

export function githubCommitStatus(input: Readonly<{
  id: number;
  context: string;
  state: 'success' | 'pending' | 'failure' | 'error';
}>): JsonRecord {
  return Object.freeze({
    id: input.id,
    node_id: 'SE_kwDOsynthetic',
    state: input.state,
    context: input.context,
    description: null,
    target_url: `https://ci.example.com/${OWNER}/${REPOSITORY}/status`,
    created_at: '2026-08-12T18:00:00Z',
    updated_at: '2026-08-12T18:04:00Z',
  });
}

export function githubReview(input: Readonly<{
  id: number;
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt?: string;
}>): JsonRecord {
  return Object.freeze({
    id: input.id,
    node_id: 'PRR_kwDOsynthetic',
    user: simpleUser(input.login, 583_240 + input.id),
    body: '',
    state: input.state,
    html_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284#pullrequestreview-${input.id}`,
    submitted_at: input.submittedAt ?? '2026-08-12T10:00:00Z',
    commit_id: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    author_association: 'MEMBER',
  });
}

/** `GET /pulls/{n}/requested_reviewers` returns TOP-LEVEL `users` and `teams`. */
export const GITHUB_REQUESTED_REVIEWERS_RESPONSE: JsonRecord = Object.freeze({
  users: Object.freeze([simpleUser('hubot', 583_232)]),
  teams: Object.freeze([
    Object.freeze({
      id: 771,
      node_id: 'T_kwDOsynthetic',
      name: 'Client Platform',
      slug: 'client-platform',
      description: null,
      privacy: 'closed',
      html_url: `https://github.com/orgs/${OWNER}/teams/client-platform`,
    }),
  ]),
});

export function githubSearchLinkHeader(input: Readonly<{
  laneQuery: string;
  perPage: number;
  nextPage: number;
}>): string {
  const url = 'https://api.github.com/search/issues'
    + `?q=${encodeURIComponent(input.laneQuery)}`
    + '&sort=updated&order=desc'
    + `&per_page=${input.perPage}&page=${input.nextPage}&advanced_search=true`;
  return `<${url}>; rel="next", <${url}>; rel="last"`;
}

/**
 * `GET /user` — the identity read behind every discovery candidate. Discovery
 * derives a candidate's display facts from this authorized response rather than
 * from host account metadata, so the fixture carries only the fields that read.
 */
export const GITHUB_AUTHENTICATED_USER_RESPONSE: JsonRecord = simpleUser('octocat-dev', 4471);

/** A second authorized account: two accounts remain two candidates, never one. */
export const GITHUB_SECOND_AUTHENTICATED_USER_RESPONSE: JsonRecord =
  simpleUser('octocat-ops', 4472);

/* ---------------------------------------------------- detail plane fixtures */

/**
 * The `Link` header GitHub returns for an ordinary paginated collection: the
 * SAME request with only `page` advanced. `scan/link.ts` accepts nothing else,
 * so a fixture that rebuilt the query differently would be refused — which is
 * exactly the point of building it from the requested URL here.
 */
export function githubFollowUpLinkHeader(input: Readonly<{
  requestedUrl: string;
  nextPage: number;
}>): string {
  const url = new URL(input.requestedUrl);
  url.searchParams.set('page', String(input.nextPage));
  return `<${url.toString()}>; rel="next", <${url.toString()}>; rel="last"`;
}

/** One ordinary timeline event, in GitHub's own `issues/{n}/timeline` shape. */
export function githubTimelineEvent(input: Readonly<{
  id: number;
  event: string;
  createdAt: string;
  actor?: string;
  label?: string;
}>): JsonRecord {
  return Object.freeze({
    id: input.id,
    node_id: `TE_kwDOsynthetic${input.id}`,
    url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/issues/events/${input.id}`,
    event: input.event,
    commit_id: null,
    commit_url: null,
    created_at: input.createdAt,
    actor: simpleUser(input.actor ?? 'octocat', 583_231),
    ...(input.label === undefined
      ? {}
      : { label: Object.freeze({ name: input.label, color: 'ededed' }) }),
  });
}

/**
 * A `reviewed` timeline event.
 *
 * It is the second shape that breaks a naive decoder, and it breaks it
 * differently from `committed`: the event IS a pull-request review resource, so
 * it names its author on `user` rather than `actor` and its instant on
 * `submitted_at` rather than `created_at`. A projector that reads only the
 * ordinary event members produces an anonymous, undated review.
 */
export function githubTimelineReviewEvent(input: Readonly<{
  id: number;
  state: string;
  submittedAt: string;
  login?: string;
}>): JsonRecord {
  return Object.freeze({
    id: input.id,
    node_id: `PRR_kwDOsynthetic${input.id}`,
    event: 'reviewed',
    user: simpleUser(input.login ?? 'octocat', 583_231),
    body: '',
    state: input.state,
    submitted_at: input.submittedAt,
    commit_id: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    author_association: 'COLLABORATOR',
    html_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284#pullrequestreview-${input.id}`,
    pull_request_url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/pulls/1284`,
  });
}

/**
 * A `committed` timeline event.
 *
 * It is the shape that breaks a naive decoder: it carries no `id` and no
 * `created_at`, and its actor is the commit author rather than an `actor`.
 */
export function githubTimelineCommitEvent(input: Readonly<{
  sha: string;
  message: string;
  committedAt: string;
  authorName?: string;
}>): JsonRecord {
  return Object.freeze({
    sha: input.sha,
    node_id: `C_kwDOsynthetic${input.sha}`,
    url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/git/commits/${input.sha}`,
    html_url: `https://github.com/${OWNER}/${REPOSITORY}/commit/${input.sha}`,
    event: 'committed',
    message: input.message,
    author: Object.freeze({
      name: input.authorName ?? 'Mona Lisa',
      email: 'mona@example.invalid',
      date: input.committedAt,
    }),
    committer: Object.freeze({
      name: input.authorName ?? 'Mona Lisa',
      email: 'mona@example.invalid',
      date: input.committedAt,
    }),
  });
}

/** One `pulls/{n}/files` row. `patch` is omitted exactly as GitHub omits it. */
export function githubChangedFile(input: Readonly<{
  filename: string;
  status?: 'added' | 'modified' | 'removed' | 'renamed';
  additions?: number;
  deletions?: number;
  previousFilename?: string;
  withPatch?: boolean;
}>): JsonRecord {
  const additions = input.additions ?? 3;
  const deletions = input.deletions ?? 1;
  return Object.freeze({
    sha: 'b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e1',
    filename: input.filename,
    status: input.status ?? 'modified',
    additions,
    deletions,
    changes: additions + deletions,
    blob_url: `https://github.com/${OWNER}/${REPOSITORY}/blob/main/${input.filename}`,
    raw_url: `https://github.com/${OWNER}/${REPOSITORY}/raw/main/${input.filename}`,
    contents_url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/contents/${input.filename}`,
    ...(input.previousFilename === undefined
      ? {}
      : { previous_filename: input.previousFilename }),
    ...(input.withPatch === false
      ? {}
      : { patch: '@@ -1,3 +1,4 @@\n context\n+added\n context' }),
  });
}

/** One `issues/{n}/comments` row. */
export function githubIssueComment(input: Readonly<{
  id: number;
  body: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
}>): JsonRecord {
  const createdAt = input.createdAt ?? '2026-08-10T10:00:00Z';
  return Object.freeze({
    id: input.id,
    node_id: `IC_kwDOsynthetic${input.id}`,
    url: `https://api.github.com/repos/${OWNER}/${REPOSITORY}/issues/comments/${input.id}`,
    html_url: `https://github.com/${OWNER}/${REPOSITORY}/pull/1284#issuecomment-${input.id}`,
    body: input.body,
    user: simpleUser(input.author ?? 'octocat', 583_231),
    created_at: createdAt,
    updated_at: input.updatedAt ?? createdAt,
    author_association: 'MEMBER',
  });
}
