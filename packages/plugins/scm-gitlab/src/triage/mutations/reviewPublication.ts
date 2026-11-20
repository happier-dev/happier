import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectTriageSourceInvocationFailureV1 } from '@happier-dev/triage-sources/runtime';
import {
  createReviewCommentPublicationSettlementRequestV1,
  parseReviewCommentPublicationPlanV1,
  formatReviewCommentPublicationMarkerV1,
  matchReviewCommentPublicationMarkerV1,
  preflightReviewCommentPublicationRoutingV1,
  reviewCommentPublicationTargetMatchesV1,
  validateReviewCommentPublicationClaimAgainstPlanV1,
  validateReviewCommentPublicationResultAgainstPlanV1,
  type ReviewCommentClaimPublicationDispatchResponseV1,
  type ReviewCommentPublicationEntryV1,
  type ReviewCommentPublicationPlanV1,
  type ReviewCommentPublicationResultV1,
} from '@happier-dev/plugin-sdk/reviews';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { GITLAB_PLUGIN_ID } from '../contribution.js';
import { buildGitlabItemUrl } from '../detail/routes.js';
import {
  GITLAB_REST_MAX_PAGE_SIZE,
  buildGitlabGraphqlUrl,
  requestGitlabJson,
  type GitlabRequestResult,
} from '../http/gitlabClient.js';
import { selectGitlabNextPageUrl } from '../http/gitlabLink.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import {
  GitlabIssueCommentInputV1Schema,
  GitlabMergeRequestReviewCommentCreateInputV1Schema,
  GitlabMergeRequestReviewPublicationInputV1Schema,
  GitlabMergeRequestThreadReplyInputV1Schema,
  type GitlabIssueStateRowV1,
  type GitlabMergeRequestStateRowV1,
  type GitlabReviewPublicationResultV1,
} from './contracts.js';
import { GITLAB_ISSUE_MUTATION_SUBJECT_V1 } from './issueRow.js';
import { GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1 } from './mergeRequestRow.js';
import {
  confirmGitlabItemMutation,
  gitlabWriteAnswerLost,
  preflightGitlabItemMutation,
  GITLAB_MUTATION_INPUT_INVALID_FAILURE,
  type GitlabMutationPreflight,
} from './preflight.js';
import { readGitlabGraphqlMutationErrors } from './graphqlDelta.js';

type RecordValue = Readonly<Record<string, unknown>>;
type PublicationPreflight = Extract<
  GitlabMutationPreflight<GitlabMergeRequestStateRowV1>,
  Readonly<{ ok: true }>
>;
type PublicationObservedRow = GitlabMergeRequestStateRowV1 | GitlabIssueStateRowV1;
type CollectionPreflight = Pick<PublicationPreflight, 'route' | 'dependencies'>;

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function externalId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : string(value);
}

function bodyWithMarker(body: string, marker: string): string {
  return `${body}\n\n${marker}`;
}

function publicationTargetMatchesRequest(
  plan: ReviewCommentPublicationPlanV1,
  request: Readonly<{
    instance: Readonly<{ binding: Readonly<{ account: Readonly<{ accountId: string }> }> }>;
    localRef: Readonly<{ kindId: string; collisionScope: string; entryId: string }>;
  }>,
  subtarget: ReviewCommentPublicationPlanV1['target']['subtarget'],
): boolean {
  return reviewCommentPublicationTargetMatchesV1(plan.target, {
    providerId: 'gitlab',
    configuredAccountId: request.instance.binding.account.accountId,
    sourceId: `${GITLAB_PLUGIN_ID}/gitlab-forge`,
    localRef: request.localRef,
    subtarget,
  });
}

type RawCollectionRow = Readonly<{ id: string; body: string }>;
type RawCollectionRead =
  | Readonly<{ ok: true; rows: readonly RawCollectionRow[]; allIds: readonly string[] }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

function matchRawCollectionMarker(rows: readonly RawCollectionRow[], exactMarker: string) {
  return matchReviewCommentPublicationMarkerV1(
    rows.map((row) => ({ externalRef: row.id, body: row.body })),
    exactMarker,
  );
}

async function readRawCollection(
  firstUrl: string,
  preflight: CollectionPreflight,
): Promise<RawCollectionRead> {
  const rows: RawCollectionRow[] = [];
  const allIds: string[] = [];
  const seen = new Set<string>();
  let url: string | null = firstUrl;
  while (url !== null) {
    if (seen.has(url)) {
      return {
        ok: false,
        failure: { class: 'unsupportedContract', code: 'gitlab-publication-pagination-nonprogress' },
      };
    }
    seen.add(url);
    const response = await requestGitlabJson({
      invocation: preflight.dependencies.invocation,
      url,
      fetcher: preflight.dependencies.fetcher,
      signal: preflight.dependencies.signal,
      nowMs: preflight.dependencies.nowMs,
    });
    if (response.kind === 'failed') {
      return { ok: false, failure: projectGitlabSourceFailure(response.failure) };
    }
    if (!Array.isArray(response.response.body)) {
      return {
        ok: false,
        failure: { class: 'unsupportedContract', code: 'gitlab-publication-list-undecodable' },
      };
    }
    for (const candidate of response.response.body) {
      const row = record(candidate);
      const id = externalId(row?.id);
      const body = string(row?.note) ?? string(row?.body);
      if (row === null || id === null) {
        return {
          ok: false,
          failure: { class: 'unsupportedContract', code: 'gitlab-publication-row-undecodable' },
        };
      }
      allIds.push(id);
      if (Array.isArray(row?.notes)) {
        for (const nestedCandidate of row.notes) {
          const nested = record(nestedCandidate);
          const nestedId = externalId(nested?.id);
          const nestedBody = string(nested?.note) ?? string(nested?.body);
          if (nested === null || nestedId === null || nestedBody === null) {
            return {
              ok: false,
              failure: { class: 'unsupportedContract', code: 'gitlab-publication-row-undecodable' },
            };
          }
          allIds.push(nestedId);
          rows.push({ id: nestedId, body: nestedBody });
        }
      } else if (body === null) {
        return {
          ok: false,
          failure: { class: 'unsupportedContract', code: 'gitlab-publication-row-undecodable' },
        };
      } else {
        rows.push({ id, body });
      }
    }
    const next = selectGitlabNextPageUrl(
      response.response.headers,
      preflight.dependencies.invocation.origin.normalized,
    );
    if (next.kind === 'refused' || next.kind === 'malformed') {
      return {
        ok: false,
        failure: { class: 'unsupportedContract', code: 'gitlab-publication-pagination-refused' },
      };
    }
    url = next.kind === 'next' ? next.url : null;
  }
  return { ok: true, rows, allIds };
}

function draftsListUrl(preflight: CollectionPreflight): string {
  return `${buildGitlabItemUrl(preflight.route)}/draft_notes?per_page=${GITLAB_REST_MAX_PAGE_SIZE}`;
}

function draftsCollectionUrl(preflight: CollectionPreflight): string {
  return `${buildGitlabItemUrl(preflight.route)}/draft_notes`;
}

function notesUrl(preflight: CollectionPreflight): string {
  return `${buildGitlabItemUrl(preflight.route)}/notes?per_page=${GITLAB_REST_MAX_PAGE_SIZE}`;
}

function discussionsUrl(preflight: CollectionPreflight): string {
  return `${buildGitlabItemUrl(preflight.route)}/discussions?per_page=${GITLAB_REST_MAX_PAGE_SIZE}`;
}

function rawReviewRevisions(body: unknown): Readonly<{
  base: string | null;
  head: string | null;
  start: string | null;
}> {
  const refs = record(record(body)?.diff_refs);
  return {
    base: string(refs?.base_sha),
    head: string(refs?.head_sha),
    start: string(refs?.start_sha),
  };
}

type DraftSpec = Readonly<{
  kind: 'entry';
  commentId?: string;
  marker: string;
  body: string;
  position?: Readonly<Record<string, unknown>>;
}>;
type SummaryEntrySpec = Readonly<{
  kind: 'summaryEntry';
  commentId: string;
  marker: string;
  body: string;
}>;
type EntrySpec = DraftSpec | SummaryEntrySpec;

async function projectEntry(
  entry: ReviewCommentPublicationEntryV1,
  plan: ReviewCommentPublicationPlanV1,
  startRevision: string,
  correlationId: string,
  route: 'inline' | 'summary',
): Promise<EntrySpec | null> {
  if (route === 'summary') {
    const marker = formatReviewCommentPublicationMarkerV1('entry', correlationId);
    return {
      kind: 'summaryEntry',
      commentId: entry.happierCommentId,
      marker,
      body: bodyWithMarker(entry.body, marker),
    };
  }
  if (entry.snapshot.kind !== 'text' || entry.snapshot.diffContext === undefined) return null;
  const diff = entry.snapshot.diffContext;
  if (diff.baseSha !== plan.baseRevision
    || diff.headSha !== plan.headRevision
    || diff.startSha !== startRevision
    || (entry.snapshot.commitSha !== undefined && entry.snapshot.commitSha !== plan.headRevision)
  ) return null;
  if (entry.anchor.kind !== 'line' && entry.anchor.kind !== 'range' && entry.anchor.kind !== 'file') return null;
  const side = entry.anchor.kind === 'file' ? diff.side : entry.anchor.side ?? diff.side;
  const lineKey = side === 'before' ? 'old_line' : 'new_line';
  const pathDigest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(entry.anchor.filePath));
  const pathHash = Array.from(new Uint8Array(pathDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const lineRange = entry.anchor.kind !== 'range'
    ? undefined
    : {
      start: {
        line_code: `${pathHash}_${side === 'before' ? entry.anchor.startLine : 0}_${side === 'after' ? entry.anchor.startLine : 0}`,
        type: side === 'before' ? 'old' : 'new',
        [lineKey]: entry.anchor.startLine,
      },
      end: {
        line_code: `${pathHash}_${side === 'before' ? entry.anchor.endLine : 0}_${side === 'after' ? entry.anchor.endLine : 0}`,
        type: side === 'before' ? 'old' : 'new',
        [lineKey]: entry.anchor.endLine,
      },
    };
  const position = {
    base_sha: plan.baseRevision,
    head_sha: plan.headRevision,
    start_sha: diff.startSha,
    position_type: entry.anchor.kind === 'file' ? 'file' : 'text',
    old_path: entry.anchor.filePath,
    new_path: entry.anchor.filePath,
    ...(entry.anchor.kind === 'line' ? { [lineKey]: entry.anchor.line } : {}),
    ...(lineRange === undefined ? {} : { line_range: lineRange }),
  };
  const marker = formatReviewCommentPublicationMarkerV1('entry', correlationId);
  return {
    kind: 'entry',
    commentId: entry.happierCommentId,
    marker,
    body: bodyWithMarker(entry.body, marker),
    position,
  };
}

function rejected(
  reason: Extract<GitlabReviewPublicationResultV1, { kind: 'rejected' }>['reason'],
  options: Readonly<{
    observed?: PublicationObservedRow;
    failure?: TriageSourceFailureV1;
    preexistingDraftCount?: number;
    preexistingDraftIds?: readonly string[];
  }> = {},
): GitlabReviewPublicationResultV1 {
  return {
    kind: 'rejected',
    reason,
    ...options,
  } as GitlabReviewPublicationResultV1;
}

function outcomeFailure(result: Extract<GitlabRequestResult, { kind: 'failed' }>) {
  const failure = projectGitlabSourceFailure(result.failure);
  return {
    failure,
    outcome: gitlabWriteAnswerLost(result)
      ? { kind: 'uncertain' as const }
      : { kind: 'failed' as const, code: failure.code, ...(failure.detail ? { message: failure.detail } : {}) },
  };
}

async function sendJson(
  preflight: CollectionPreflight,
  request: Readonly<{ url: string; method: 'POST' | 'PUT'; body?: unknown }>,
) {
  return await requestGitlabJson({
    invocation: preflight.dependencies.invocation,
    url: request.url,
    method: request.method,
    ...(request.body === undefined ? {} : { body: request.body }),
    fetcher: preflight.dependencies.fetcher,
    signal: preflight.dependencies.signal,
    nowMs: preflight.dependencies.nowMs,
  });
}

async function claimPublication(
  plan: ReviewCommentPublicationPlanV1,
  context: PluginAccountActionContext,
  signal: AbortSignal,
): Promise<ReviewCommentClaimPublicationDispatchResponseV1 | null> {
  try {
    const candidate = await context.services.actions.execute(
      'reviews.comments.claimPublicationDispatch',
      plan,
      { signal },
    );
    return validateReviewCommentPublicationClaimAgainstPlanV1(plan, candidate);
  } catch (error) {
    signal.throwIfAborted();
    if (isPluginError(error) || error instanceof Error && error.name === 'AbortError') throw error;
    return null;
  }
}

const GITLAB_SETTLEMENT_UNAVAILABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'transient',
  code: 'gitlab-publication-settlement-unavailable',
  detail: 'GitLab accepted this publication, but Happier could not record its outcome.',
});

/**
 * Records the outcome with the canonical claim owner.
 *
 * External publication truth and Happier's record of it are two facts, and only
 * one of them just failed. A settlement transport failure therefore neither
 * discards the provider references this invocation proved nor cancels the
 * mandatory post-mutation observation (`sources/SCM.md` §3.9.3): it is returned
 * as a stated failure. The server keeps the claim outstanding, so recovery stays
 * the next explicit claim's decision — nothing here retries, replays or waits.
 *
 * Cancellation remains cancellation and propagates unchanged.
 */
async function reportPublication(
  plan: ReviewCommentPublicationPlanV1,
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  result: ReviewCommentPublicationResultV1,
  context: PluginAccountActionContext,
  signal: AbortSignal,
): Promise<TriageSourceFailureV1 | null> {
  try {
    await context.services.actions.execute(
      'reviews.comments.claimPublicationDispatch',
      createReviewCommentPublicationSettlementRequestV1(plan, claim, result),
      { signal },
    );
    return null;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return isPluginError(error)
      ? projectTriageSourceInvocationFailureV1(error, GITLAB_SETTLEMENT_UNAVAILABLE_FAILURE.code)
      : GITLAB_SETTLEMENT_UNAVAILABLE_FAILURE;
  }
}

function resultForStoppedCreate(
  plan: ReviewCommentPublicationPlanV1,
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  orderedPlanIndexes: readonly number[],
  failedSequenceIndex: number,
  failedOutcome: Readonly<{ kind: 'failed'; code: string; message?: string }> | Readonly<{ kind: 'uncertain' }>,
): ReviewCommentPublicationResultV1 {
  return validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
    publicationPlanId: claim.publicationPlanId,
    entries: plan.entries.map((entry, index) => {
      const instruction = claim.instructions.entries[index];
      const prior = claim.priorResult?.entries[index];
      if ((instruction === 'confirmed' || instruction === 'held') && prior !== undefined) {
        return prior;
      }
      const sequenceIndex = orderedPlanIndexes.indexOf(index);
      return {
      happierCommentId: entry.happierCommentId,
      publicationCorrelationId: claim.entries[index]!.publicationCorrelationId,
      outcome: sequenceIndex >= 0 && sequenceIndex < failedSequenceIndex
        ? { kind: 'uncertain' }
        : sequenceIndex === failedSequenceIndex
          ? failedOutcome
          : { kind: 'skippedPriorFailure' },
      };
    }),
    verdict: plan.verdict === null || claim.verdict === null
      ? { kind: 'notRequested' }
      : {
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: { kind: 'skippedPriorFailure' },
      },
  });
}

async function settleWithObservation<TRow extends PublicationObservedRow>(
  preflight: Extract<GitlabMutationPreflight<TRow>, Readonly<{ ok: true }>>,
  publication: ReviewCommentPublicationResultV1,
  preexistingDraftCount: number,
  failure?: TriageSourceFailureV1,
): Promise<GitlabReviewPublicationResultV1> {
  const confirmed = await confirmGitlabItemMutation({
    localRef: preflight.localRef,
    route: preflight.route,
    dependencies: preflight.dependencies,
    subject: preflight.subject,
  });
  return {
    kind: 'settled',
    publication,
    preexistingDraftCount,
    ...(confirmed.ok ? { observed: confirmed.row } : {}),
    ...(failure !== undefined ? { failure } : !confirmed.ok ? { failure: confirmed.failure } : {}),
  };
}

type GitlabVerdictSummaryEffectOutcome =
  | Readonly<{ kind: 'failed'; code: string; message?: string }>
  | Readonly<{ kind: 'uncertain' }>;

type GitlabVerdictSummary =
  | Readonly<{ kind: 'published'; externalRef: string }>
  | Readonly<{
    kind: 'unresolved';
    failure: TriageSourceFailureV1;
    outcome: GitlabVerdictSummaryEffectOutcome;
  }>;

/**
 * Brings the verdict summary comment into existence exactly once.
 *
 * The summary carries the verdict's own exact marker, and the marker is derived
 * from the plan, so it survives across attempts. This invocation has already read
 * the complete notes and pending-draft collections; consulting them here is what
 * makes an explicitly permitted retry dispatch only the effect that actually
 * remains. Creating a second summary after a definite approval denial would both
 * repeat public prose the reader already wrote and make the marker ambiguous —
 * the one condition attribution can never recover from.
 *
 * It does not replay anything on its own: a summary that is already published is
 * reported, a draft that already exists is published, and nothing else changes.
 */
async function ensureGitlabVerdictSummary(input: Readonly<{
  preflight: PublicationPreflight;
  marker: string;
  body: string;
  publishedRows: readonly RawCollectionRow[];
  pendingDraftRows: readonly RawCollectionRow[];
}>): Promise<GitlabVerdictSummary> {
  const { preflight, marker } = input;
  const alreadyPublished = matchRawCollectionMarker(input.publishedRows, marker);
  if (alreadyPublished.kind === 'unique') {
    return { kind: 'published', externalRef: alreadyPublished.externalRef };
  }
  const pendingDraft = matchRawCollectionMarker(input.pendingDraftRows, marker);
  if (alreadyPublished.kind === 'duplicate' || pendingDraft.kind === 'duplicate') {
    return {
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'gitlab-publication-marker-duplicate' },
      outcome: { kind: 'uncertain' },
    };
  }

  let draftId = pendingDraft.kind === 'unique' ? pendingDraft.externalRef : null;
  if (draftId === null) {
    const created = await sendJson(preflight, {
      url: draftsCollectionUrl(preflight),
      method: 'POST',
      body: { note: input.body },
    });
    draftId = created.kind === 'ok' ? externalId(record(created.response.body)?.id) : null;
    if ((created.kind === 'failed' && gitlabWriteAnswerLost(created))
      || (created.kind === 'ok' && draftId === null)) {
      const reread = await readRawCollection(draftsListUrl(preflight), preflight);
      const matched = reread.ok ? matchRawCollectionMarker(reread.rows, marker) : null;
      draftId = matched?.kind === 'unique' ? matched.externalRef : null;
    }
    if (draftId === null) {
      return {
        kind: 'unresolved',
        failure: created.kind === 'failed'
          ? projectGitlabSourceFailure(created.failure)
          : { class: 'unsupportedContract', code: 'gitlab-verdict-draft-create-unconfirmed' },
        outcome: created.kind === 'failed' && !gitlabWriteAnswerLost(created)
          ? outcomeFailure(created).outcome
          : { kind: 'uncertain' },
      };
    }
  }

  const published = await sendJson(preflight, {
    url: `${buildGitlabItemUrl(preflight.route)}/draft_notes/${encodeURIComponent(draftId)}/publish`,
    method: 'PUT',
  });
  const summaryRead = await readRawCollection(notesUrl(preflight), preflight);
  const summary = summaryRead.ok ? matchRawCollectionMarker(summaryRead.rows, marker) : null;
  if (summary?.kind === 'unique') {
    return { kind: 'published', externalRef: summary.externalRef };
  }
  return {
    kind: 'unresolved',
    failure: published.kind === 'failed'
      ? projectGitlabSourceFailure(published.failure)
      : summaryRead.ok
        ? { class: 'unsupportedContract', code: 'gitlab-verdict-summary-unconfirmed' }
        : summaryRead.failure,
    outcome: published.kind === 'failed' && !gitlabWriteAnswerLost(published)
      ? outcomeFailure(published).outcome
      : { kind: 'uncertain' },
  };
}

/** GitLab orderedPartial review publication through draft notes and a last verdict. */
export async function publishGitlabMergeRequestReview(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<GitlabReviewPublicationResultV1> {
  const parsed = GitlabMergeRequestReviewPublicationInputV1Schema.safeParse(input);
  if (!parsed.success) return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  const request = parsed.data;
  let plan: ReviewCommentPublicationPlanV1;
  try {
    plan = parseReviewCommentPublicationPlanV1(request.publicationPlan);
  } catch {
    return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  }
  if (!publicationTargetMatchesRequest(plan, request, null)) {
    return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  }
  const routing = preflightReviewCommentPublicationRoutingV1(plan);
  if (routing.kind === 'rejected') return rejected('unsupported_anchor');

  const current = await preflightGitlabItemMutation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    expectedRevision: plan.headRevision ?? undefined,
  }, context);
  if (!current.ok) {
    return current.refusal.kind === 'reconfirmationRequired'
      ? rejected('head_advanced', { observed: current.refusal.observed })
      : rejected('admission_failed', { failure: current.refusal.failure });
  }
  if (current.row.state !== 'opened') return rejected('state_changed', { observed: current.row });
  const revisions = rawReviewRevisions(current.body);
  if (revisions.base !== plan.baseRevision) return rejected('base_advanced', { observed: current.row });
  if (revisions.head !== plan.headRevision) return rejected('head_advanced', { observed: current.row });
  if (revisions.start === null) return rejected('start_advanced', { observed: current.row });
  // Read the complete pending-draft collection before the canonical claim. A
  // human draft has no Happier marker; surfacing it here prevents our claim from
  // becoming the reason a later retry can never dispatch.
  const initialDrafts = await readRawCollection(draftsListUrl(current), current);
  if (!initialDrafts.ok) return rejected('admission_failed', { observed: current.row, failure: initialDrafts.failure });
  const preexistingDrafts = initialDrafts.rows;
  const acknowledged = [...(request.acknowledgedPreexistingDraftIds ?? [])].sort();
  const currentPreexistingIds = preexistingDrafts.map((draft) => draft.id).sort();
  if (preexistingDrafts.length > 0 && (
    acknowledged.length !== currentPreexistingIds.length
    || acknowledged.some((id, index) => id !== currentPreexistingIds[index])
  )) {
    return rejected('preexisting_drafts', {
      observed: current.row,
      preexistingDraftCount: preexistingDrafts.length,
      preexistingDraftIds: currentPreexistingIds,
    });
  }

  const claim = await claimPublication(plan, context, current.dependencies.signal);
  if (claim === null) return rejected('dispatch_claim_failed', { observed: current.row });
  const settlePublication = async (
    publication: ReviewCommentPublicationResultV1,
    failure?: TriageSourceFailureV1,
  ): Promise<GitlabReviewPublicationResultV1> => {
    const settlementFailure = await reportPublication(
      plan,
      claim,
      publication,
      context,
      current.dependencies.signal,
    );
    return await settleWithObservation(
      current,
      publication,
      preexistingDrafts.length,
      failure ?? settlementFailure ?? undefined,
    );
  };
  const specs = await Promise.all(plan.entries.map((entry, index) => projectEntry(
    entry,
    plan,
    revisions.start!,
    claim.entries[index]!.publicationCorrelationId,
    routing.verdictSummaryEntryIndexes.includes(index) ? 'summary' : 'inline',
  )));
  if (specs.some((spec, index) => spec === null && claim.instructions.entries[index] === 'dispatch')) {
    const publication = validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: claim.entries.map((entry, index) => {
        const instruction = claim.instructions.entries[index];
        const prior = claim.priorResult?.entries[index];
        return (instruction === 'confirmed' || instruction === 'held') && prior !== undefined
          ? prior
          : {
            ...entry,
            outcome: instruction !== 'dispatch'
              ? { kind: 'uncertain' }
              : specs[index] === null
                ? { kind: 'failed', code: 'unsupported_anchor' }
                : { kind: 'skippedPriorFailure' },
          };
      }),
      verdict: plan.verdict === null || claim.verdict === null
        ? { kind: 'notRequested' }
        : (claim.instructions.verdict === 'confirmed' || claim.instructions.verdict === 'held')
          && claim.priorResult !== null && !('kind' in claim.priorResult.verdict)
          ? claim.priorResult.verdict
          : { ...claim.verdict, outcome: { kind: 'skippedPriorFailure' } },
    });
    const failure = await reportPublication(plan, claim, publication, context, current.dependencies.signal);
    return rejected('unsupported_anchor', { observed: current.row, ...(failure === null ? {} : { failure }) });
  }

  // DiscussionNote is excluded from GitLab's Notes API. Discussions includes
  // both inline threads and ordinary notes, so a mixed review reconciles once
  // through that collection; summary-only plans retain the ordinary Notes read.
  const publishedBefore = await readRawCollection(
    routing.inlineEntryIndexes.length > 0 ? discussionsUrl(current) : notesUrl(current),
    current,
  );
  if (!publishedBefore.ok) {
    const uncertain = validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: plan.entries.map((entry, index) => {
        const instruction = claim.instructions.entries[index];
        const prior = claim.priorResult?.entries[index];
        return (instruction === 'confirmed' || instruction === 'held') && prior !== undefined
          ? prior
          : {
            happierCommentId: entry.happierCommentId,
            publicationCorrelationId: claim.entries[index]!.publicationCorrelationId,
            outcome: { kind: 'uncertain' as const },
          };
      }),
      verdict: plan.verdict === null || claim.verdict === null
        ? { kind: 'notRequested' }
        : (claim.instructions.verdict === 'confirmed' || claim.instructions.verdict === 'held')
          && claim.priorResult !== null && !('kind' in claim.priorResult.verdict)
          ? claim.priorResult.verdict
          : { publicationCorrelationId: claim.verdict.publicationCorrelationId, outcome: { kind: 'uncertain' } },
    });
    return await settlePublication(uncertain, publishedBefore.failure);
  }

  const reconcileEntry = (
    entry: ReviewCommentPublicationEntryV1,
    index: number,
  ): ReviewCommentPublicationResultV1['entries'][number] => {
    const instruction = claim.instructions.entries[index];
    const prior = claim.priorResult?.entries[index];
    if ((instruction === 'confirmed' || instruction === 'held') && prior !== undefined) return prior;
    const marker = formatReviewCommentPublicationMarkerV1('entry', claim.entries[index]!.publicationCorrelationId);
    const published = matchRawCollectionMarker(publishedBefore.rows, marker);
    const pendingDraft = matchRawCollectionMarker(initialDrafts.rows, marker);
    return {
      happierCommentId: entry.happierCommentId,
      publicationCorrelationId: claim.entries[index]!.publicationCorrelationId,
      outcome: published.kind === 'unique'
        ? { kind: 'published', externalRef: published.externalRef }
        : pendingDraft.kind === 'unique'
          ? { kind: 'failed', code: 'gitlab-publication-draft-pending' }
          : { kind: 'uncertain' },
    };
  };

  if (claim.disposition === 'reconcile') {
    const publication = validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: plan.entries.map(reconcileEntry),
      verdict: plan.verdict === null || claim.verdict === null
        ? { kind: 'notRequested' }
        : (() => {
          if ((claim.instructions.verdict === 'confirmed' || claim.instructions.verdict === 'held')
            && claim.priorResult !== null && !('kind' in claim.priorResult.verdict)) {
            return claim.priorResult.verdict;
          }
          const summary = matchRawCollectionMarker(
            publishedBefore.rows,
            formatReviewCommentPublicationMarkerV1('verdict', claim.verdict!.publicationCorrelationId),
          );
          return {
            publicationCorrelationId: claim.verdict.publicationCorrelationId,
            outcome: summary.kind !== 'unique'
              ? { kind: 'uncertain' as const }
              : plan.verdict!.kind === 'comment'
                ? { kind: 'published' as const, externalRef: summary.externalRef }
                // The summary is exactly attributable; markerless approval is
                // not. Preserve the proven half without guessing the approval.
                : { kind: 'uncertain' as const, externalRef: summary.externalRef },
          };
        })(),
    });
    return await settlePublication(publication);
  }

  const inlineSpecs = specs.flatMap((spec, planIndex) => spec?.kind === 'entry'
    && claim.instructions.entries[planIndex] === 'dispatch'
    ? [{ spec, planIndex }]
    : []);
  const summarySpecs = specs.flatMap((spec, planIndex) => spec?.kind === 'summaryEntry'
    && claim.instructions.entries[planIndex] === 'dispatch'
    ? [{ spec, planIndex }]
    : []);
  const draftIds: string[] = [];
  for (let index = 0; index < inlineSpecs.length; index += 1) {
    const spec = inlineSpecs[index]!.spec;
    const existing = matchRawCollectionMarker(initialDrafts.rows, spec.marker);
    if (existing.kind === 'unique') {
      draftIds.push(existing.externalRef);
      continue;
    }
    if (existing.kind === 'duplicate') {
      return await settlePublication(
        resultForStoppedCreate(
          plan,
          claim,
          inlineSpecs.map((candidate) => candidate.planIndex),
          index,
          { kind: 'uncertain' },
        ),
        { class: 'unsupportedContract', code: 'gitlab-publication-marker-duplicate' },
      );
    }
    const created = await sendJson(current, {
      url: draftsCollectionUrl(current),
      method: 'POST',
      body: { note: spec.body, ...(spec.position === undefined ? {} : { position: spec.position }) },
    });
    if (created.kind === 'failed') {
      const failed = outcomeFailure(created);
      if (failed.outcome.kind === 'uncertain') {
        const reread = await readRawCollection(draftsListUrl(current), current);
        const found = reread.ok ? matchRawCollectionMarker(reread.rows, spec.marker) : null;
        if (found?.kind === 'unique') {
          draftIds.push(found.externalRef);
          continue;
        }
      }
      return await settlePublication(
        resultForStoppedCreate(
          plan,
          claim,
          inlineSpecs.map((candidate) => candidate.planIndex),
          index,
          failed.outcome,
        ),
        failed.failure,
      );
    }
    const id = externalId(record(created.response.body)?.id);
    if (id === null) {
      const reread = await readRawCollection(draftsListUrl(current), current);
      const found = reread.ok ? matchRawCollectionMarker(reread.rows, spec.marker) : null;
      if (found?.kind === 'unique') {
        draftIds.push(found.externalRef);
        continue;
      }
      return await settlePublication(
        resultForStoppedCreate(
          plan,
          claim,
          inlineSpecs.map((candidate) => candidate.planIndex),
          index,
          { kind: 'uncertain' },
        ),
        { class: 'unsupportedContract', code: 'gitlab-draft-create-response-undecodable' },
      );
    }
    draftIds.push(id);
  }

  const entryOutcomes: Array<RecordValue | undefined> = plan.entries.map((entry, index) =>
    claim.instructions.entries[index] === 'dispatch' ? undefined : reconcileEntry(entry, index).outcome);
  let terminalFailure: TriageSourceFailureV1 | undefined;
  for (let index = 0; index < inlineSpecs.length; index += 1) {
    const { spec, planIndex } = inlineSpecs[index]!;
    if (terminalFailure !== undefined) {
      entryOutcomes[planIndex] = { kind: 'skippedPriorFailure' };
      continue;
    }
    const published = await sendJson(current, {
      url: `${buildGitlabItemUrl(current.route)}/draft_notes/${encodeURIComponent(draftIds[index]!)}/publish`,
      method: 'PUT',
    });
    if (published.kind === 'failed') {
      const failed = outcomeFailure(published);
      if (failed.outcome.kind === 'uncertain') {
        const reread = await readRawCollection(discussionsUrl(current), current);
        const found = reread.ok ? matchRawCollectionMarker(reread.rows, spec.marker) : null;
        if (found?.kind === 'unique') {
          entryOutcomes[planIndex] = { kind: 'published', externalRef: found.externalRef };
          continue;
        }
      }
      terminalFailure = failed.failure;
      entryOutcomes[planIndex] = failed.outcome;
      continue;
    }
    const reread = await readRawCollection(discussionsUrl(current), current);
    const confirmed = reread.ok ? matchRawCollectionMarker(reread.rows, spec.marker) : null;
    if (confirmed?.kind !== 'unique') {
      terminalFailure = reread.ok
        ? { class: 'unsupportedContract', code: 'gitlab-draft-publish-unconfirmed' }
        : reread.failure;
      entryOutcomes[planIndex] = { kind: 'uncertain' };
      continue;
    }
    entryOutcomes[planIndex] = { kind: 'published', externalRef: confirmed.externalRef };
  }

  let verdictOutcome: RecordValue = plan.verdict === null || claim.verdict === null
    ? { kind: 'notRequested' }
    : (claim.instructions.verdict === 'confirmed' || claim.instructions.verdict === 'held')
      && claim.priorResult !== null && !('kind' in claim.priorResult.verdict)
      ? claim.priorResult.verdict
      : {
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: { kind: 'skippedPriorFailure' },
      };
  if (plan.verdict !== null && claim.verdict !== null && claim.instructions.verdict === 'dispatch') {
    if (terminalFailure !== undefined) {
      for (const { planIndex } of summarySpecs) {
        entryOutcomes[planIndex] = { kind: 'skippedPriorFailure' };
      }
      verdictOutcome = {
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: { kind: 'skippedPriorFailure' },
      };
    } else {
      const marker = formatReviewCommentPublicationMarkerV1('verdict', claim.verdict.publicationCorrelationId);
      const summary = await ensureGitlabVerdictSummary({
        preflight: current,
        marker,
        body: [
          ...summarySpecs.map(({ spec }) => spec.body),
          bodyWithMarker(plan.verdict.body, marker),
        ].join('\n\n'),
        publishedRows: publishedBefore.rows,
        pendingDraftRows: initialDrafts.rows,
      });
      if (summary.kind !== 'published') {
        terminalFailure = summary.failure;
        for (const { planIndex } of summarySpecs) entryOutcomes[planIndex] = summary.outcome;
        verdictOutcome = {
          publicationCorrelationId: claim.verdict.publicationCorrelationId,
          outcome: summary.outcome,
        };
      } else {
        for (const { planIndex } of summarySpecs) {
          entryOutcomes[planIndex] = { kind: 'published', externalRef: summary.externalRef };
        }
        if (plan.verdict.kind === 'comment') {
          verdictOutcome = {
            publicationCorrelationId: claim.verdict.publicationCorrelationId,
            outcome: { kind: 'published', externalRef: summary.externalRef },
          };
        } else {
          // GitLab exposes Request changes through GraphQL, with the same configured-origin
          // invocation as REST. The summary and inline comments still publish before the verdict.
          const approval = await sendJson(current, {
            url: plan.verdict.kind === 'approve' ? `${buildGitlabItemUrl(current.route)}/approve`
              : buildGitlabGraphqlUrl(current.route.origin),
            method: 'POST',
            body: plan.verdict.kind === 'approve' ? { sha: plan.headRevision } : {
              query: 'mutation RequestReviewChanges($projectPath: ID!, $iid: String!) { mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) { errors mergeRequest { id } } }',
              variables: { projectPath: current.route.repositoryKey, iid: current.route.iid },
            },
          });
          if (approval.kind === 'failed') {
            const failed = outcomeFailure(approval);
            terminalFailure = failed.failure;
            verdictOutcome = {
              publicationCorrelationId: claim.verdict.publicationCorrelationId,
              outcome: { ...failed.outcome, externalRef: summary.externalRef },
            };
          } else {
            const messages = plan.verdict.kind === 'requestChanges'
              ? readGitlabGraphqlMutationErrors(approval.response.body, 'mergeRequestRequestChanges') : [];
            const payload = record(record(record(approval.response.body)?.data)?.mergeRequestRequestChanges);
            const unconfirmed = plan.verdict.kind === 'requestChanges'
              && externalId(record(payload?.mergeRequest)?.id) === null;
            if (messages.length > 0) {
              terminalFailure = { class: 'unsupportedContract', code: 'gitlab-request-changes-rejected', detail: messages.join('\n') };
            } else if (unconfirmed) {
              terminalFailure = { class: 'unsupportedContract', code: 'gitlab-request-changes-unconfirmed' };
            }
            verdictOutcome = {
              publicationCorrelationId: claim.verdict.publicationCorrelationId,
              outcome: messages.length > 0
                ? { kind: 'failed', code: terminalFailure!.code, message: terminalFailure!.detail, externalRef: summary.externalRef }
                : { kind: unconfirmed ? 'uncertain' : 'published', externalRef: summary.externalRef },
            };
          }
        }
      }
    }
  }

  const publication = validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
    publicationPlanId: claim.publicationPlanId,
    entries: plan.entries.map((entry, index) => ({
      happierCommentId: entry.happierCommentId,
      publicationCorrelationId: claim.entries[index]!.publicationCorrelationId,
      outcome: entryOutcomes[index] ?? { kind: 'skippedPriorFailure' },
    })),
    verdict: verdictOutcome,
  });
  return await settlePublication(publication, terminalFailure);
}

function singleEntryPublication(
  plan: ReviewCommentPublicationPlanV1,
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  outcome: ReviewCommentPublicationResultV1['entries'][number]['outcome'],
): ReviewCommentPublicationResultV1 {
  return validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
    publicationPlanId: claim.publicationPlanId,
    entries: [{
      happierCommentId: plan.entries[0]!.happierCommentId,
      publicationCorrelationId: claim.entries[0]!.publicationCorrelationId,
      outcome,
    }],
    verdict: { kind: 'notRequested' },
  });
}

async function publishSingleComment<TRow extends PublicationObservedRow>(options: Readonly<{
  plan: ReviewCommentPublicationPlanV1;
  context: PluginAccountActionContext;
  preflight: Extract<GitlabMutationPreflight<TRow>, Readonly<{ ok: true }>>;
  readUrl: string;
  requireCollection?: (collection: Extract<RawCollectionRead, { ok: true }>) => boolean;
  buildWrite: (markedBody: string, correlationId: string) => Readonly<{
    url: string;
    body: unknown;
  }> | null | Promise<Readonly<{ url: string; body: unknown }> | null>;
}>): Promise<GitlabReviewPublicationResultV1> {
  const before = await readRawCollection(options.readUrl, options.preflight);
  if (!before.ok) {
    return rejected('admission_failed', { observed: options.preflight.row, failure: before.failure });
  }
  if (options.requireCollection !== undefined && !options.requireCollection(before)) {
    return rejected('invalid_input', {
      observed: options.preflight.row,
      failure: { class: 'unsupportedContract', code: 'gitlab-publication-subtarget-not-found' },
    });
  }
  const claim = await claimPublication(
    options.plan,
    options.context,
    options.preflight.dependencies.signal,
  );
  if (claim === null) return rejected('dispatch_claim_failed', { observed: options.preflight.row });
  const settlePublication = async (
    publication: ReviewCommentPublicationResultV1,
    failure?: TriageSourceFailureV1,
  ): Promise<GitlabReviewPublicationResultV1> => {
    const settlementFailure = await reportPublication(
      options.plan,
      claim,
      publication,
      options.context,
      options.preflight.dependencies.signal,
    );
    return await settleWithObservation(
      options.preflight,
      publication,
      0,
      failure ?? settlementFailure ?? undefined,
    );
  };
  const correlationId = claim.entries[0]!.publicationCorrelationId;
  const marker = formatReviewCommentPublicationMarkerV1('entry', correlationId);
  const existing = matchRawCollectionMarker(before.rows, marker);
  if (claim.disposition === 'reconcile' || existing.kind !== 'absent') {
    const instruction = claim.instructions.entries[0];
    const prior = claim.priorResult?.entries[0]?.outcome;
    const publication = singleEntryPublication(
      options.plan,
      claim,
      (instruction === 'confirmed' || instruction === 'held') && prior !== undefined
        ? prior
        : existing.kind !== 'unique'
        ? { kind: 'uncertain' }
        : { kind: 'published', externalRef: existing.externalRef },
    );
    return await settlePublication(publication);
  }

  const write = await options.buildWrite(bodyWithMarker(options.plan.entries[0]!.body, marker), correlationId);
  if (write === null) {
    const failure = await reportPublication(
      options.plan,
      claim,
      singleEntryPublication(options.plan, claim, { kind: 'failed', code: 'unsupported_anchor' }),
      options.context,
      options.preflight.dependencies.signal,
    );
    return rejected('unsupported_anchor', { observed: options.preflight.row, ...(failure === null ? {} : { failure }) });
  }
  const sent = await sendJson(options.preflight, { url: write.url, method: 'POST', body: write.body });
  if (sent.kind === 'failed' && !gitlabWriteAnswerLost(sent)) {
    const failed = outcomeFailure(sent);
    return await settlePublication(
      singleEntryPublication(options.plan, claim, failed.outcome),
      failed.failure,
    );
  }
  const after = await readRawCollection(options.readUrl, options.preflight);
  const found = after.ok ? matchRawCollectionMarker(after.rows, marker) : null;
  const failure = sent.kind === 'failed'
    ? projectGitlabSourceFailure(sent.failure)
    : after.ok
      ? { class: 'unsupportedContract' as const, code: 'gitlab-publication-write-unconfirmed' }
      : after.failure;
  return await settlePublication(
    singleEntryPublication(
      options.plan,
      claim,
      found?.kind !== 'unique'
        ? { kind: 'uncertain' }
        : { kind: 'published', externalRef: found.externalRef },
    ),
    found?.kind !== 'unique' ? failure : undefined,
  );
}

function parsePublicationPlan(input: unknown): ReviewCommentPublicationPlanV1 | null {
  try {
    return parseReviewCommentPublicationPlanV1(input);
  } catch {
    return null;
  }
}

/** Publish one revision-pinned merge-request discussion note. */
export async function publishGitlabMergeRequestReviewComment(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<GitlabReviewPublicationResultV1> {
  const parsed = GitlabMergeRequestReviewCommentCreateInputV1Schema.safeParse(input);
  if (!parsed.success) return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  const request = parsed.data;
  const plan = parsePublicationPlan(request.publicationPlan);
  if (plan === null || !publicationTargetMatchesRequest(plan, request, null)) {
    return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  }
  const routing = preflightReviewCommentPublicationRoutingV1(plan);
  if (routing.kind === 'rejected' || routing.inlineEntryIndexes.length !== 1) {
    return rejected('unsupported_anchor');
  }
  const current = await preflightGitlabItemMutation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    expectedRevision: plan.headRevision ?? undefined,
  }, context);
  if (!current.ok) {
    return current.refusal.kind === 'reconfirmationRequired'
      ? rejected('head_advanced', { observed: current.refusal.observed })
      : rejected('admission_failed', { failure: current.refusal.failure });
  }
  if (current.row.state !== 'opened') return rejected('state_changed', { observed: current.row });
  const revisions = rawReviewRevisions(current.body);
  if (revisions.base !== plan.baseRevision) return rejected('base_advanced', { observed: current.row });
  if (revisions.head !== plan.headRevision) return rejected('head_advanced', { observed: current.row });
  if (revisions.start === null) return rejected('start_advanced', { observed: current.row });
  return await publishSingleComment({
    plan,
    context,
    preflight: current,
    readUrl: discussionsUrl(current),
    buildWrite: async (_markedBody, correlationId) => {
      const spec = await projectEntry(plan.entries[0]!, plan, revisions.start!, correlationId, 'inline');
      return spec === null || spec.kind !== 'entry' ? null : {
        url: `${buildGitlabItemUrl(current.route)}/discussions`,
        body: { body: spec.body, position: spec.position },
      };
    },
  });
}

/** Publish one reply into one exact merge-request discussion. */
export async function publishGitlabMergeRequestThreadReply(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<GitlabReviewPublicationResultV1> {
  const parsed = GitlabMergeRequestThreadReplyInputV1Schema.safeParse(input);
  if (!parsed.success) return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  const request = parsed.data;
  const plan = parsePublicationPlan(request.publicationPlan);
  if (plan === null || !publicationTargetMatchesRequest(plan, request, {
    kindId: 'review-thread',
    targetId: request.discussionId,
  })) return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  const current = await preflightGitlabItemMutation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
  }, context);
  if (!current.ok) {
    return current.refusal.kind === 'reconfirmationRequired'
      ? rejected('head_advanced', { observed: current.refusal.observed })
      : rejected('admission_failed', { failure: current.refusal.failure });
  }
  if (current.row.state !== 'opened') return rejected('state_changed', { observed: current.row });
  return await publishSingleComment({
    plan,
    context,
    preflight: current,
    readUrl: discussionsUrl(current),
    requireCollection: (collection) => collection.allIds.includes(request.discussionId),
    buildWrite: (markedBody) => ({
      url: `${buildGitlabItemUrl(current.route)}/discussions/${encodeURIComponent(request.discussionId)}/notes`,
      body: { body: markedBody },
    }),
  });
}

/** Publish one canonical issue comment without inventing an issue revision. */
export async function publishGitlabIssueComment(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<GitlabReviewPublicationResultV1> {
  const parsed = GitlabIssueCommentInputV1Schema.safeParse(input);
  if (!parsed.success) return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  const request = parsed.data;
  const plan = parsePublicationPlan(request.publicationPlan);
  if (plan === null || !publicationTargetMatchesRequest(plan, request, null)) {
    return rejected('invalid_input', { failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE });
  }
  const current = await preflightGitlabItemMutation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    subject: GITLAB_ISSUE_MUTATION_SUBJECT_V1,
  }, context);
  if (!current.ok) {
    return current.refusal.kind === 'reconfirmationRequired'
      ? rejected('head_advanced', { observed: current.refusal.observed })
      : rejected('admission_failed', { failure: current.refusal.failure });
  }
  const collectionUrl = `${buildGitlabItemUrl(current.route)}/notes?per_page=${GITLAB_REST_MAX_PAGE_SIZE}`;
  return await publishSingleComment({
    plan,
    context,
    preflight: current,
    readUrl: collectionUrl,
    buildWrite: (markedBody) => ({
      url: `${buildGitlabItemUrl(current.route)}/notes`,
      body: { body: markedBody },
    }),
  });
}
