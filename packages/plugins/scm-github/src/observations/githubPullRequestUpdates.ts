import { createHash } from 'node:crypto';
import type { ConversationResolvedEndpointV1, SessionPullRequestUpdateEventV1, SessionPullRequestUpdateV1 } from '@happier-dev/channels-protocol/v1';
import { ScmHostingRepositoryIdentityV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import type { GithubApiClientV1, GithubApiMediaClientV1 } from './githubApiClient.js';
import type { GithubChannelProviderConfigV1 } from './githubProviderContracts.js';
import { readGithubPositiveDecimal } from './githubProviderContracts.js';
import { readValidatedGithubFollowUpPage } from '../triage/scan/link.js';
import { pollGithubRepositoryEvents } from './githubRepositoryEventsPolling.js';
import { readGithubCheckOutcomeV1 } from '../triage/checkOutcome.js';
import type { GithubCheckObservationV1 } from '../triage/checks.js';
import { readGithubFailureContext } from '../actions/evidence.js';
import { readGithubUpdatedCommentWindow } from './githubUpdatedCommentWindow.js';
import { GithubApiResponseError } from './githubRepositoryResolution.js';
import { parseGithubIssueCommentCursor, type GithubIssueCommentCursorPositionV1 } from './githubIssueCommentCursor.js';
import { readGithubResourceIntent } from '../triage/locator.js';

type RecordValue = Readonly<Record<string, unknown>>;
type Event = SessionPullRequestUpdateEventV1;
type Head = SessionPullRequestUpdateV1['head'];
export type GithubPullRequestUpdateCheckpoint = {
  head: Head;
  state: string;
  conflict: boolean;
  inlineAt: string;
  inlineRevisions: Record<string, string>;
  reviews: Record<string, string>;
  checks: Record<string, string>;
  commentsBaseline?: GithubIssueCommentCursorPositionV1;
};
export type GithubPullRequestUpdateCandidate = Readonly<{ event: Event; readInlineCommentIds?(): Promise<string[]>; commit(): void }>;
export class GithubPullRequestUpdateHistoryGapError extends Error {}

function record(value: unknown): value is RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string { if (typeof value !== 'string' || !value) throw new RangeError('GitHub PR evidence is missing a native string'); return value; }
function time(value: unknown): number { const result = Date.parse(text(value)); if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('GitHub PR evidence has an invalid provider timestamp'); return result; }
function revision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('base64url'); }
function dictionary(value: unknown): value is Record<string, string> { return record(value) && Object.values(value).every(item => typeof item === 'string'); }

export function parseGithubPullRequestUpdateCheckpoints(value: unknown): Record<string, GithubPullRequestUpdateCheckpoint> {
  if (value === undefined) return {};
  if (!record(value)) throw new RangeError('GitHub PR checkpoint is invalid');
  const result: Record<string, GithubPullRequestUpdateCheckpoint> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!record(entry) || !record(entry.head) || typeof entry.head.sha !== 'string' || !entry.head.sha || typeof entry.head.ref !== 'string' || !entry.head.ref
      || typeof entry.state !== 'string' || typeof entry.conflict !== 'boolean' || typeof entry.inlineAt !== 'string'
      || !dictionary(entry.inlineRevisions) || !dictionary(entry.reviews) || !dictionary(entry.checks)) throw new RangeError('GitHub PR checkpoint is invalid');
    time(entry.inlineAt);
    const commentsBaseline = entry.commentsBaseline === undefined ? undefined : parseGithubIssueCommentCursor({
      ...(record(entry.commentsBaseline) ? entry.commentsBaseline : {}), v: 1, etag: null,
    });
    result[id] = { head: { sha: entry.head.sha, ref: entry.head.ref,
      ...(entry.head.repository === undefined ? {} : { repository: ScmHostingRepositoryIdentityV1ProtocolSchema.parse(entry.head.repository) }) }, state: entry.state, conflict: entry.conflict, inlineAt: entry.inlineAt,
      inlineRevisions: { ...entry.inlineRevisions }, reviews: { ...entry.reviews }, checks: { ...entry.checks },
      ...(commentsBaseline ? { commentsBaseline: { updatedAtIso: commentsBaseline.updatedAtIso, commentIdAtUpdatedAt: commentsBaseline.commentIdAtUpdatedAt } } : {}),
    };
  }
  return result;
}

export function githubPullRequestEventAuthor(value: unknown): Event['author'] {
  if (!record(value)) return { principalId: null, kind: 'unknown' };
  let principalId: string | null = null;
  try { principalId = readGithubPositiveDecimal(value.id, 'PR event actor'); } catch { /* Deleted/unknown actors stay unattributed. */ }
  return { principalId, kind: value.type === 'Bot' ? 'bot' : value.type === 'User' ? 'person' : 'unknown',
    ...(typeof value.login === 'string' && value.login ? { label: value.login } : {}) };
}

function common(raw: RecordValue, id: string, occurredAt: number, basis: unknown) {
  const url = typeof raw.html_url === 'string' && raw.html_url ? raw.html_url : undefined;
  const resource = url === undefined ? undefined : readGithubResourceIntent(url);
  return { id, revision: revision(basis), occurredAt, ...(url === undefined ? {} : { url }), ...(resource === undefined ? {} : { resource }), author: githubPullRequestEventAuthor(raw.user) };
}

/** The provider continuation validator is shared with all other GitHub collections. */
async function readPages(client: GithubApiClientV1, initialUrl: string, repositoryId: string, signal: AbortSignal): Promise<readonly RecordValue[]> {
  const rows: RecordValue[] = [];
  let url: string | null = initialUrl;
  const visited = new Set<string>();
  while (url !== null) {
    signal.throwIfAborted();
    if (visited.has(url)) throw new GithubPullRequestUpdateHistoryGapError('GitHub PR pagination repeated a page');
    visited.add(url);
    const response = await client.request({ url });
    if (response.status !== 200) throw new GithubApiResponseError(response);
    const decoded: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (!Array.isArray(decoded) || decoded.some(row => !record(row))) throw new RangeError('GitHub PR evidence must be an array of objects');
    rows.push(...decoded as RecordValue[]);
    const next = readValidatedGithubFollowUpPage(response.headers, url, repositoryId);
    if (next.kind === 'invalid') throw new GithubPullRequestUpdateHistoryGapError('GitHub PR evidence has an unsafe continuation');
    url = next.kind === 'next' ? next.url : null;
  }
  return rows;
}

/** One demanded repository stream per Channel cycle, shared by all linked PRs. */
export async function readGithubPullRequestInlineComments(client: GithubApiClientV1, config: GithubChannelProviderConfigV1, since: string | null, signal: AbortSignal) {
  const route = `https://api.github.com/repos/${encodeURIComponent(config.repository.owner)}/${encodeURIComponent(config.repository.name)}`;
  const window = await readGithubUpdatedCommentWindow({ startPosition: { updatedAtIso: since ?? '1970-01-01T00:00:00.000Z', commentIdAtUpdatedAt: '0' }, etag: null,
    position: (raw: RecordValue) => ({ updatedAtIso: new Date(time(raw.updated_at)).toISOString(), commentIdAtUpdatedAt: readGithubPositiveDecimal(raw.id, 'inline comment ID') }),
    readPage: async (position, _etag, nextPageUrl) => {
      signal.throwIfAborted();
      const url = nextPageUrl ?? `${route}/pulls/comments?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(new Date(Math.max(0, time(position.updatedAtIso) - 1000)).toISOString())}`;
      const response = await client.request({ url });
      if (response.status !== 200) throw new GithubApiResponseError(response);
      const rows: unknown = JSON.parse(new TextDecoder().decode(response.body));
      if (!Array.isArray(rows) || rows.some(row => !record(row))) throw new RangeError('GitHub inline comments must be an array');
      const next = readValidatedGithubFollowUpPage(response.headers, url, config.repository.repositoryId);
      if (next.kind === 'invalid') throw new GithubPullRequestUpdateHistoryGapError('GitHub inline comments have an unsafe continuation');
      return { kind: 'page', comments: rows as RecordValue[], etag: null, morePages: next.kind === 'next',
        nextPageUrl: next.kind === 'next' ? next.url : null, headers: response.headers };
    },
  });
  return window.comments;
}

/** Native actor evidence is acquired only for a changed head, never from commit authors. */
async function pushEvidence(input: Readonly<{ client: GithubApiClientV1; config: GithubChannelProviderConfigV1; pr: RecordValue; head: Head; signal: AbortSignal }>): Promise<Pick<Event, 'id' | 'revision' | 'occurredAt' | 'author'> | null> {
  const nativeHead = record(input.pr.head) ? input.pr.head : null;
  const nativeRepository = nativeHead && record(nativeHead.repo) ? nativeHead.repo : null;
  if (nativeRepository === null) return null;
  const repositoryId = readGithubPositiveDecimal(nativeRepository.id, 'head repository ID');
  const repository = typeof nativeRepository.full_name === 'string' ? nativeRepository.full_name : repositoryId === input.config.repository.repositoryId ? input.config.repository.nameWithOwner : null;
  if (repository === null || !/^[^/]+\/[^/]+$/u.test(repository)) return null;
  const timeline = await pollGithubRepositoryEvents({ initialUrl: `https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}/events?per_page=100`, etag: null,
    getPage: async ({ url }) => {
      input.signal.throwIfAborted();
      const response = await input.client.request({ url });
      if (response.status !== 200) return { kind: 'page', etag: null, nextUrl: null, events: [], pollIntervalMs: null };
      const decoded: unknown = JSON.parse(new TextDecoder().decode(response.body));
      if (!Array.isArray(decoded)) throw new RangeError('GitHub Events must be an array');
      const next = readValidatedGithubFollowUpPage(response.headers, url, repositoryId);
      if (next.kind === 'invalid') throw new RangeError('GitHub Events continuation is unsafe');
      return { kind: 'page', etag: null, nextUrl: next.kind === 'next' ? next.url : null, pollIntervalMs: null,
        events: decoded.map(raw => {
          if (!record(raw)) throw new RangeError('GitHub Event must be an object');
          return { eventId: text(raw.id), createdAtMs: time(raw.created_at), observation: raw };
        }) };
    } });
  if (timeline.kind !== 'events') return null;
  const matching = timeline.events.filter(entry => {
    const raw = entry.observation;
    return raw !== null && raw.type === 'PushEvent' && record(raw.repo) && String(raw.repo.id) === repositoryId && record(raw.payload)
      && raw.payload.head === input.head.sha && raw.payload.ref === `refs/heads/${input.head.ref}`;
  }).at(-1);
  if (!matching?.observation || !record(matching.observation.actor)) return null;
  const actor = matching.observation.actor;
  const author = githubPullRequestEventAuthor({ ...actor, type: actor.type });
  return { id: `github:push:${matching.eventId}`, revision: matching.eventId, occurredAt: matching.createdAtMs, author };
}

export async function collectGithubPullRequestUpdates(input: Readonly<{
  client: GithubApiClientV1; config: GithubChannelProviderConfigV1; endpoint: ConversationResolvedEndpointV1;
  pr: RecordValue; number: number; state: string; previous?: GithubPullRequestUpdateCheckpoint;
  baseline: boolean; feedback: boolean; commentBaseline?: GithubIssueCommentCursorPositionV1; inlineRows?: readonly RecordValue[]; checks?: readonly GithubCheckObservationV1[]; signal: AbortSignal;
}>): Promise<Readonly<{ head: Head | null; checkpoint?: GithubPullRequestUpdateCheckpoint; candidates: readonly GithubPullRequestUpdateCandidate[]; finish?(): void }>> {
  const nativeHead = record(input.pr.head) ? input.pr.head : null;
  if (!nativeHead || typeof nativeHead.sha !== 'string' || !nativeHead.sha) return { head: null, candidates: [] };
  // A ref is provider evidence. Older consumers that requested only CI did not
  // retain it, so they can still receive CI facts without fabricating a branch.
  if (typeof nativeHead.ref !== 'string' || !nativeHead.ref) return { head: null, candidates: [] };
  const nativeRepository = record(nativeHead.repo) ? nativeHead.repo : null;
  const head: Head = { sha: nativeHead.sha, ref: nativeHead.ref,
    ...(nativeRepository && typeof nativeRepository.full_name === 'string' && nativeRepository.full_name ? {
      repository: ScmHostingRepositoryIdentityV1ProtocolSchema.parse({ kind: 'github', deployment: 'https://github.com', repository: nativeRepository.full_name }),
    } : {}),
  };
  const previous = input.previous;
  const feedbackBaseline = input.feedback && previous?.commentsBaseline === undefined;
  const checkpoint: GithubPullRequestUpdateCheckpoint = previous ?? { head, state: input.state, conflict: input.pr.mergeable === false,
    inlineAt: '1970-01-01T00:00:00.000Z', inlineRevisions: {}, reviews: {}, checks: {},
    ...(input.feedback && input.commentBaseline ? { commentsBaseline: input.commentBaseline } : {}),
  };
  if (feedbackBaseline && input.commentBaseline) checkpoint.commentsBaseline = input.commentBaseline;
  if (!input.feedback) { delete checkpoint.commentsBaseline; checkpoint.inlineAt = '1970-01-01T00:00:00.000Z'; checkpoint.inlineRevisions = {}; checkpoint.reviews = {}; }
  const candidates: GithubPullRequestUpdateCandidate[] = [];
  let finish: (() => void) | undefined;
  const route = `https://api.github.com/repos/${encodeURIComponent(input.config.repository.owner)}/${encodeURIComponent(input.config.repository.name)}`;
  if (input.feedback) {
    const inline = input.inlineRows ?? [];
    let repositoryInlineAt = checkpoint.inlineAt;
    const inlineEvents: Extract<Event, { kind: 'inlineComment' }>[] = [];
    for (const raw of inline) {
      const providerAt = new Date(time(raw.updated_at)).toISOString();
      if (providerAt > repositoryInlineAt) repositoryInlineAt = providerAt;
      const url = new URL(text(raw.pull_request_url));
      if (url.origin !== 'https://api.github.com' || url.pathname !== `/repos/${input.config.repository.owner}/${input.config.repository.name}/pulls/${input.number}`) continue;
      const id = readGithubPositiveDecimal(raw.id, 'inline comment ID');
      if (typeof raw.body !== 'string') throw new RangeError('GitHub inline comment body is unavailable');
      const occurredAt = time(raw.updated_at);
      const event: Extract<Event, { kind: 'inlineComment' }> = { ...common(raw, id, occurredAt, [raw.body, raw.updated_at, raw.line, raw.path, raw.diff_hunk, raw.in_reply_to_id]), kind: 'inlineComment', body: raw.body,
        path: text(raw.path), line: typeof raw.line === 'number' && Number.isSafeInteger(raw.line) && raw.line > 0 ? raw.line : null, diffHunk: typeof raw.diff_hunk === 'string' ? raw.diff_hunk : text(raw.diff_hunk),
        ...(raw.pull_request_review_id == null ? {} : { reviewId: readGithubPositiveDecimal(raw.pull_request_review_id, 'review ID') }),
        ...(raw.in_reply_to_id == null ? {} : { inReplyToId: readGithubPositiveDecimal(raw.in_reply_to_id, 'reply comment ID') }) };
      inlineEvents.push(event);
    }
    const commitInline = (event: Event) => {
      const iso = new Date(event.occurredAt).toISOString();
      if (iso > checkpoint.inlineAt) { checkpoint.inlineAt = iso; checkpoint.inlineRevisions = {}; }
      if (iso === checkpoint.inlineAt) checkpoint.inlineRevisions[event.id] = event.revision;
    };
    let pendingInline = 0;
    for (const event of inlineEvents.sort(compareGithubPullRequestEvents)) {
      if (previous === undefined || input.baseline || feedbackBaseline) { commitInline(event); continue; }
      if (event.occurredAt < time(previous.inlineAt) || event.occurredAt === time(previous.inlineAt) && previous.inlineRevisions[event.id] === event.revision) continue;
      pendingInline += 1;
      candidates.push({ event, commit: () => { commitInline(event); pendingInline -= 1; } });
    }
    finish = () => {
      // Irrelevant PR rows are classified too, but a trailing relevant event
      // held by the containing poll limit keeps its source boundary reachable.
      if (pendingInline === 0 && repositoryInlineAt > checkpoint.inlineAt) {
        checkpoint.inlineAt = repositoryInlineAt;
        checkpoint.inlineRevisions = {};
      }
    };
    const reviews = await readPages(input.client, `${route}/pulls/${input.number}/reviews?per_page=100`, input.config.repository.repositoryId, input.signal);
    for (const raw of reviews) {
      if (raw.submitted_at == null || raw.state === 'PENDING') continue;
      const id = readGithubPositiveDecimal(raw.id, 'review ID');
      const verdict = raw.state === 'APPROVED' ? 'approved' : raw.state === 'CHANGES_REQUESTED' ? 'changesRequested' : raw.state === 'COMMENTED' ? 'commented' : raw.state === 'DISMISSED' ? 'dismissed' : null;
      if (verdict === null || typeof raw.body !== 'string') throw new RangeError('GitHub submitted review evidence is invalid');
      const basis = [raw.body, raw.state, raw.submitted_at, raw.commit_id];
      const key = revision(basis);
      if (previous === undefined || input.baseline || feedbackBaseline) { checkpoint.reviews[id] = key; continue; }
      if (previous.reviews[id] === key) continue;
      const event: Event = { ...common(raw, id, time(raw.submitted_at), basis), kind: 'review', body: raw.body, verdict,
        inlineCommentIds: [] };
      candidates.push({ event, readInlineCommentIds: async () => {
        const members = await readPages(input.client, `${route}/pulls/${input.number}/reviews/${id}/comments?per_page=100`, input.config.repository.repositoryId, input.signal);
        return members.map(member => readGithubPositiveDecimal(member.id, 'review inline comment ID')).sort((a, b) => a.length - b.length || a.localeCompare(b));
      }, commit: () => { checkpoint.reviews[id] = key; } });
    }
  }
  if (previous && !input.baseline) {
    if (head.sha !== previous.head.sha || head.ref !== previous.head.ref) {
      const measured = await pushEvidence({ ...input, head });
      const author = measured?.author ?? { principalId: null, kind: 'unknown' as const };
      const event: Event = { ...(measured ?? { id: `github:head:${input.number}:${head.sha}`, revision: head.sha, occurredAt: time(input.pr.updated_at), author }), kind: 'push', sha: head.sha, ref: head.ref,
        writer: author.principalId === null ? 'unknown' : author.principalId === input.config.integrationPrincipal.id ? 'own' : 'other' };
      candidates.push({ event, commit: () => { checkpoint.head = head; } });
    }
    if (input.pr.mergeable === false && !previous.conflict) {
      const occurredAt = time(input.pr.updated_at);
      const event: Event = { id: `github:conflict:${input.number}:${head.sha}`, revision: revision([head.sha, input.pr.updated_at, false]), occurredAt, author: { principalId: null, kind: 'process' }, kind: 'conflict', mergeable: false };
      candidates.push({ event, commit: () => { checkpoint.conflict = true; } });
    } else if (input.pr.mergeable === true) checkpoint.conflict = false;
    if ((input.state === 'merged' || input.state === 'closed') && input.state !== previous.state) {
      const at = input.state === 'merged' ? input.pr.merged_at : input.pr.closed_at;
      const event: Event = { id: `github:${input.state}:${input.number}`, revision: revision([input.state, at]), occurredAt: time(at), author: githubPullRequestEventAuthor(input.state === 'merged' ? input.pr.merged_by : null), kind: input.state };
      candidates.push({ event, commit: () => { checkpoint.state = input.state; } });
    } else if (input.state === 'open') checkpoint.state = 'open';
  }
  for (const check of input.checks ?? []) {
    const outcome = readGithubCheckOutcomeV1(check);
    if (outcome === 'pending' || outcome === 'unknown') continue;
    const occurredAt = check.completedAtMs ?? check.startedAtMs ?? check.checkSuiteCreatedAtMs;
    if (occurredAt == null) continue;
    const state = outcome === 'failed' ? 'failed' : outcome === 'passed' ? 'passed' : 'finished';
    const key = revision([head.sha, check.key, check.status, check.conclusion, occurredAt]);
    if (input.baseline) { checkpoint.checks[check.key] = key; continue; }
    if (checkpoint.checks[check.key] === key) continue;
    const resource = check.detailsUrl ? readGithubResourceIntent(check.detailsUrl) : undefined;
    const fields = { id: check.key, revision: key, occurredAt, ...(check.detailsUrl ? { url: check.detailsUrl } : {}), ...(resource === undefined ? {} : { resource }), author: { principalId: null, kind: 'process' as const }, kind: 'check' as const, logicalCheckId: check.key, name: check.name };
    const event: Event = state === 'failed' ? { ...fields, state, failure: { kind: 'unavailable', reason: 'github_ci_exact_actions_evidence_unavailable' } } : { ...fields, state };
    candidates.push({ event, commit: () => { checkpoint.checks[check.key] = key; } });
  }
  return { head, checkpoint, candidates, ...(finish ? { finish } : {}) };
}

export function compareGithubPullRequestEvents(left: Event, right: Event): number {
  return left.occurredAt - right.occurredAt || left.id.length - right.id.length || left.id.localeCompare(right.id) || left.revision.localeCompare(right.revision);
}

/** Only admitted failed transitions acquire logs, through the plan-02 adapter. */
export async function enrichGithubPullRequestCheckFailure(client: GithubApiClientV1, event: Event, check: GithubCheckObservationV1 | undefined, maxSerializedBytes: number, signal: AbortSignal): Promise<Event> {
  if (event.kind !== 'check' || event.state !== 'failed' || !check?.actions) return event;
  if (maxSerializedBytes <= 0) return { ...event, failure: { kind: 'unavailable', reason: 'budget_insufficient' } };
  if (!('requestMedia' in client) || typeof client.requestMedia !== 'function') return event;
  signal.throwIfAborted();
  const selection = check.actions.selection;
  const run = selection.kind === 'run' ? selection.run : selection.attempt.run;
  try {
    const result = await readGithubFailureContext(client as GithubApiMediaClientV1, { repository: run.repository, selection, excerpt: { failedOnly: true, contextLines: 0, tailLines: 0 }, maxSerializedBytes });
    signal.throwIfAborted();
    if (result.kind === 'value' && result.value.headSha === check.actions.headSha) return { ...event, failure: { kind: 'summary', summary: result.value } };
    return { ...event, failure: { kind: 'unavailable', reason: result.kind === 'unavailable' && result.failure.code === 'insufficient_summary_budget' ? 'budget_insufficient' : 'github_ci_failure_evidence_unavailable' } };
  } catch {
    signal.throwIfAborted();
    return { ...event, failure: { kind: 'unavailable', reason: 'github_ci_failure_evidence_unavailable' } };
  }
}
