import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  formatReviewCommentPublicationMarkerV1,
  matchReviewCommentPublicationMarkerV1,
  parseReviewCommentPublicationPlanV1,
  preflightReviewCommentPublicationRoutingV1,
  reviewCommentPublicationEntryIsDiffLessV1,
  reviewCommentPublicationTargetMatchesV1,
  validateReviewCommentPublicationClaimAgainstPlanV1,
  validateReviewCommentPublicationResultAgainstPlanV1,
  type ReviewCommentClaimPublicationDispatchResponseV1,
  type ReviewCommentPublicationEntryResultV1,
  type ReviewCommentPublicationEntryV1,
  type ReviewCommentPublicationPlanV1,
  type ReviewCommentPublicationResultV1,
} from '@happier-dev/plugin-sdk/reviews';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { AZURE_DEVOPS_PLUGIN_ID } from '../azureDevopsContracts.js';
import { AZURE_CHANGES_PAGE_SIZE_V1 } from './detail/reads.js';
import { AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID } from './descriptor.js';
import { projectAzureSourceFailure } from './failureProjection.js';
import {
  admitAzureMutation,
  observeAzureMutation,
  type AzureMutationContext,
} from './mutationActions.js';
import {
  AzureSubmitReviewInputV1Schema,
  AzureThreadCommentCreateInputV1Schema,
  AzureThreadReplyInputV1Schema,
  type AzureReviewPublicationResultV1,
} from './mutations/contracts.js';
import {
  createAzurePullRequestThread,
  createAzurePullRequestThreadReply,
  setAzurePullRequestReviewerVote,
  type AzureCreatedCommentOutcomeV1,
  type AzureWriteOutcomeV1,
} from './mutations/pullRequestWrites.js';
import type { AzureDevOpsFailure } from './types.js';

const SOURCE_ID = `${AZURE_DEVOPS_PLUGIN_ID}/${AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID}`;

type NativeComment = Readonly<{ threadId: number; externalRef: string; content: string }>;
type ThreadInventory = Readonly<{
  comments: readonly NativeComment[];
  parentCommentIdsByThread: ReadonlyMap<number, ReadonlySet<number>>;
}>;
type PublicationMode =
  | Readonly<{ kind: 'submit' }>
  | Readonly<{ kind: 'comment' }>
  | Readonly<{ kind: 'reply'; threadId: number; parentCommentId: number }>;
type PublicationContext = Readonly<Record<string, unknown>>;
type PublicationWrite =
  | Readonly<{ kind: 'accepted'; externalRef?: string }>
  | Readonly<{ kind: 'failed'; failure: AzureDevOpsFailure }>
  | Readonly<{ kind: 'ambiguous'; failure: AzureDevOpsFailure }>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isAmbiguousWriteFailure(failure: AzureDevOpsFailure): boolean {
  return failure.class === 'server'
    || failure.class === 'transport'
    || failure.class === 'timedOut'
    || failure.class === 'cancelled';
}

function malformed(detail: string): AzureDevOpsFailure {
  return {
    class: 'malformedResponse', status: null, detail, typeKey: null,
    retryNotBeforeMs: null, rateLimit: null,
  };
}

async function readThreadInventory(
  mutation: AzureMutationContext,
): Promise<Readonly<{ ok: true; value: ThreadInventory }> | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>> {
  const response = await mutation.client.request({
    route: { resource: 'threads', ...mutation.address },
    signal: mutation.signal,
  });
  if (!response.ok) return { ok: false, failure: projectAzureSourceFailure(response.failure) };
  const body = record(response.body);
  const rows = body !== null && Array.isArray(body.value) ? body.value : null;
  if (rows === null) {
    return { ok: false, failure: projectAzureSourceFailure(malformed('Azure DevOps returned an unusable thread collection.')) };
  }
  const comments: NativeComment[] = [];
  const parents = new Map<number, ReadonlySet<number>>();
  for (const rawThread of rows) {
    const thread = record(rawThread);
    if (thread?.isDeleted === true) continue;
    const threadId = positiveInteger(thread?.id);
    if (threadId === null || !Array.isArray(thread?.comments)) {
      return { ok: false, failure: projectAzureSourceFailure(malformed('Azure DevOps returned an incomplete thread while reconciling publication markers.')) };
    }
    const ids = new Set<number>();
    for (const rawComment of thread.comments) {
      const comment = record(rawComment);
      if (comment?.isDeleted === true) continue;
      const id = positiveInteger(comment?.id);
      const content = typeof comment?.content === 'string' ? comment.content : null;
      if (id === null || content === null) {
        return { ok: false, failure: projectAzureSourceFailure(malformed('Azure DevOps returned an incomplete comment while reconciling publication markers.')) };
      }
      ids.add(id);
      comments.push(Object.freeze({ threadId, externalRef: `${threadId}:${id}`, content }));
    }
    parents.set(threadId, ids);
  }
  return { ok: true, value: Object.freeze({ comments: Object.freeze(comments), parentCommentIdsByThread: parents }) };
}

function lookupMarker(
  inventory: ThreadInventory,
  exactMarker: string,
  threadId?: number,
): Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'duplicate' }> | Readonly<{ kind: 'unique'; comment: NativeComment }> {
  const candidates = inventory.comments.filter((comment) => threadId === undefined || comment.threadId === threadId);
  const match = matchReviewCommentPublicationMarkerV1(
    candidates.map((comment) => ({ externalRef: comment.externalRef, body: comment.content })),
    exactMarker,
  );
  return match.kind !== 'unique'
    ? match
    : { kind: 'unique', comment: candidates.find((comment) => comment.externalRef === match.externalRef)! };
}

function findMarker(inventory: ThreadInventory, exactMarker: string, threadId?: number): NativeComment | undefined {
  const found = lookupMarker(inventory, exactMarker, threadId);
  return found.kind === 'unique' ? found.comment : undefined;
}

function expectedSubtarget(mode: PublicationMode): ReviewCommentPublicationPlanV1['target']['subtarget'] {
  return mode.kind === 'reply'
    ? Object.freeze({ kindId: 'review-thread', targetId: String(mode.threadId) })
    : null;
}

function targetMatches(
  plan: ReviewCommentPublicationPlanV1,
  request: Readonly<{
    instance: { binding: { account: { accountId: string } } };
    localRef: { kindId: string; collisionScope: string; entryId: string };
  }>,
  mode: PublicationMode,
): boolean {
  const subtarget = expectedSubtarget(mode);
  return reviewCommentPublicationTargetMatchesV1(plan.target, {
    providerId: 'azure-devops',
    configuredAccountId: request.instance.binding.account.accountId,
    sourceId: SOURCE_ID,
    localRef: request.localRef,
    subtarget,
  });
}

function snapshotMatchesPlan(entry: ReviewCommentPublicationEntryV1, plan: ReviewCommentPublicationPlanV1): boolean {
  if (entry.snapshot.kind !== 'text') return false;
  const diff = entry.snapshot.diffContext;
  return diff !== undefined
    && diff.baseSha === plan.baseRevision
    && diff.headSha === plan.headRevision
    && (diff.startSha === undefined || diff.startSha === plan.baseRevision)
    && (entry.snapshot.commitSha === undefined || entry.snapshot.commitSha === plan.headRevision);
}

function summarySnapshotMatchesPlan(
  entry: ReviewCommentPublicationEntryV1,
  plan: ReviewCommentPublicationPlanV1,
): boolean {
  if (entry.snapshot.kind !== 'text') return true;
  const diff = entry.snapshot.diffContext;
  return (diff === undefined
    || (diff.baseSha === plan.baseRevision && diff.headSha === plan.headRevision))
    && (diff?.startSha === undefined || diff.startSha === plan.baseRevision)
    && (entry.snapshot.commitSha === undefined || entry.snapshot.commitSha === plan.headRevision);
}

function canonicalAzurePath(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

type RawChangedFile = Readonly<{ path: string; changeTrackingId: number }>;

async function readCurrentChangedFiles(
  mutation: AzureMutationContext,
): Promise<Readonly<{ ok: true; iterationId: number; rows: readonly RawChangedFile[] }> | Readonly<{ ok: false; failure: AzureDevOpsFailure }>> {
  const iterations = await mutation.client.request({
    route: { resource: 'iterations', ...mutation.address }, signal: mutation.signal,
  });
  if (!iterations.ok) return iterations;
  const iterationsBody = record(iterations.body);
  if (iterationsBody === null || !Array.isArray(iterationsBody.value)) {
    return { ok: false, failure: malformed('Azure DevOps returned an unusable iteration collection.') };
  }
  let iterationId: number | null = null;
  for (const raw of iterationsBody.value) {
    const id = positiveInteger(record(raw)?.id);
    if (id === null) return { ok: false, failure: malformed('Azure DevOps returned an incomplete iteration row.') };
    if (iterationId === null || id > iterationId) iterationId = id;
  }
  if (iterationId === null) return { ok: false, failure: malformed('Azure DevOps returned no current pull-request iteration.') };

  const rows: RawChangedFile[] = [];
  let skip = 0;
  let top = AZURE_CHANGES_PAGE_SIZE_V1;
  const seen = new Set<string>();
  while (true) {
    const key = `${skip}:${top}`;
    if (seen.has(key)) return { ok: false, failure: malformed('Azure DevOps repeated an iteration-changes continuation position.') };
    seen.add(key);
    const response = await mutation.client.request({
      route: { resource: 'iterationChanges', ...mutation.address, iterationId },
      query: { $compareTo: 0, $skip: skip, $top: top },
      signal: mutation.signal,
    });
    if (!response.ok) return response;
    const body = record(response.body);
    const changes = body !== null && Array.isArray(body.changeEntries)
      ? body.changeEntries
      : body !== null && Array.isArray(body.value) ? body.value : null;
    if (body === null || changes === null) return { ok: false, failure: malformed('Azure DevOps returned an unusable iteration-changes collection.') };
    for (const raw of changes) {
      const change = record(raw);
      const item = record(change?.item);
      const path = typeof item?.path === 'string' && item.path.length > 0 ? item.path : null;
      const changeTrackingId = positiveInteger(change?.changeTrackingId);
      if (path === null || changeTrackingId === null) {
        return { ok: false, failure: malformed('Azure DevOps returned an incomplete iteration change required for an inline comment.') };
      }
      rows.push(Object.freeze({ path, changeTrackingId }));
    }
    const hasSkip = Object.prototype.hasOwnProperty.call(body, 'nextSkip');
    const hasTop = Object.prototype.hasOwnProperty.call(body, 'nextTop');
    if (hasSkip !== hasTop) return { ok: false, failure: malformed('Azure DevOps returned an incomplete iteration-changes continuation.') };
    if (!hasSkip) break;
    const nextSkip = nonNegativeInteger(body.nextSkip);
    const nextTop = nonNegativeInteger(body.nextTop);
    if (nextSkip === null || nextTop === null) return { ok: false, failure: malformed('Azure DevOps returned an invalid iteration-changes continuation.') };
    if (nextSkip === 0 && nextTop === 0) break;
    skip = nextSkip;
    top = nextTop;
  }
  return { ok: true, iterationId, rows: Object.freeze(rows) };
}

function inlineContext(
  entry: ReviewCommentPublicationEntryV1,
  plan: ReviewCommentPublicationPlanV1,
  changed: Readonly<{ iterationId: number; rows: readonly RawChangedFile[] }>,
): PublicationContext | null {
  if ((entry.anchor.kind !== 'file' && entry.anchor.kind !== 'line' && entry.anchor.kind !== 'range')
    || !snapshotMatchesPlan(entry, plan)) return null;
  const anchor = entry.anchor;
  const matches = changed.rows.filter((row) => (
    canonicalAzurePath(row.path) === canonicalAzurePath(anchor.filePath)
  ));
  if (matches.length !== 1) return null;
  const threadContext: Record<string, unknown> = { filePath: matches[0]!.path };
  if (anchor.kind === 'line' || anchor.kind === 'range') {
    const diff = entry.snapshot.kind === 'text' ? entry.snapshot.diffContext : undefined;
    if (diff === undefined) return null;
    const side = anchor.side ?? diff.side;
    const startLine = anchor.kind === 'line' ? anchor.line : anchor.startLine;
    const endLine = anchor.kind === 'line' ? anchor.line : anchor.endLine;
    const start = { line: startLine, offset: 1 };
    const end = { line: endLine, offset: 1 };
    Object.assign(threadContext, side === 'before'
      ? { leftFileStart: start, leftFileEnd: end }
      : { rightFileStart: start, rightFileEnd: end });
  }
  return Object.freeze({
    threadContext: Object.freeze(threadContext),
    pullRequestThreadContext: Object.freeze({
      changeTrackingId: matches[0]!.changeTrackingId,
      // Azure iterations are 1-based. This is the same first→current comparison used by the
      // provider's documented create-thread example (1→2); `0` belongs only to changes `$compareTo`.
      iterationContext: Object.freeze({ firstComparingIteration: 1, secondComparingIteration: changed.iterationId }),
    }),
  });
}

function legacyInlineContext(
  entry: ReviewCommentPublicationEntryV1,
  plan: ReviewCommentPublicationPlanV1,
): PublicationContext | null {
  if ((entry.anchor.kind !== 'file' && entry.anchor.kind !== 'line' && entry.anchor.kind !== 'range')
    || !snapshotMatchesPlan(entry, plan)) return null;
  const anchor = entry.anchor;
  const threadContext: Record<string, unknown> = { filePath: anchor.filePath };
  if (anchor.kind === 'line' || anchor.kind === 'range') {
    const diff = entry.snapshot.kind === 'text' ? entry.snapshot.diffContext : undefined;
    if (diff === undefined) return null;
    const side = anchor.side ?? diff.side;
    const startLine = anchor.kind === 'line' ? anchor.line : anchor.startLine;
    const endLine = anchor.kind === 'line' ? anchor.line : anchor.endLine;
    const start = { line: startLine, offset: 1 };
    const end = { line: endLine, offset: 1 };
    Object.assign(threadContext, side === 'before'
      ? { leftFileStart: start, leftFileEnd: end }
      : { rightFileStart: start, rightFileEnd: end });
  }
  return Object.freeze({ threadContext: Object.freeze(threadContext) });
}

function threadBody(content: string, context: PublicationContext): Readonly<Record<string, unknown>> {
  return Object.freeze({ comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 1, ...context });
}

function normalizeCommentWrite(written: AzureCreatedCommentOutcomeV1): PublicationWrite {
  if (written.ok) return { kind: 'accepted', externalRef: written.externalRef };
  return isAmbiguousWriteFailure(written.failure)
    ? { kind: 'ambiguous', failure: written.failure }
    : { kind: 'failed', failure: written.failure };
}

function normalizeWrite(written: AzureWriteOutcomeV1): PublicationWrite {
  if (written.ok) return { kind: 'accepted' };
  return isAmbiguousWriteFailure(written.failure)
    ? { kind: 'ambiguous', failure: written.failure }
    : { kind: 'failed', failure: written.failure };
}

function failureOutcome(failure: AzureDevOpsFailure) {
  const projected = projectAzureSourceFailure(failure);
  return Object.freeze({
    kind: 'failed' as const,
    code: projected.code,
    ...(projected.detail === undefined ? {} : { message: projected.detail }),
  });
}

async function finalObservation(mutation: AzureMutationContext) {
  const observed = await observeAzureMutation(mutation);
  return observed.row === null
    ? observed.observation.kind === 'unresolved'
      ? { failure: observed.observation.failure }
      : {}
    : { observation: observed.observation };
}

async function claimPlan(
  context: PluginInvocationContext,
  mutation: AzureMutationContext,
  plan: ReviewCommentPublicationPlanV1,
): Promise<ReviewCommentClaimPublicationDispatchResponseV1> {
  return validateReviewCommentPublicationClaimAgainstPlanV1(
    plan,
    await context.services.actions.execute(
      'reviews.comments.claimPublicationDispatch', plan, { signal: mutation.signal },
    ),
  );
}

function reconcileEntry(
  entry: ReviewCommentPublicationEntryV1,
  correlationId: string,
  inventory: ThreadInventory | null,
  threadId?: number,
): ReviewCommentPublicationEntryResultV1 {
  const found = inventory === null
    ? undefined
    : findMarker(inventory, formatReviewCommentPublicationMarkerV1('entry', correlationId), threadId);
  return Object.freeze({
    happierCommentId: entry.happierCommentId,
    publicationCorrelationId: correlationId,
    outcome: found === undefined
      ? Object.freeze({ kind: 'uncertain' as const })
      : Object.freeze({ kind: 'published' as const, externalRef: found.externalRef }),
  });
}

function revisionsMatch(
  plan: ReviewCommentPublicationPlanV1,
  current: Awaited<ReturnType<typeof observeAzureMutation>>,
): boolean {
  return current.row !== null
    && (plan.baseRevision === null || current.row.lastMergeTargetCommitId === plan.baseRevision)
    && (plan.headRevision === null || current.row.lastMergeSourceCommitId === plan.headRevision);
}

async function admitPublicationEffect(
  mutation: AzureMutationContext,
  plan: ReviewCommentPublicationPlanV1,
): Promise<
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; outcome: ReviewCommentPublicationEntryResultV1['outcome']; failure?: TriageSourceFailureV1 }>
> {
  const observed = await observeAzureMutation(mutation);
  if (observed.row === null) {
    return observed.observation.kind === 'unresolved'
      ? { ok: false, outcome: { kind: 'uncertain' }, failure: observed.observation.failure }
      : { ok: false, outcome: { kind: 'failed', code: 'azure-devops/review-target-unavailable' } };
  }
  if (observed.row.status !== 'active' || !revisionsMatch(plan, observed)) {
    return {
      ok: false,
      outcome: {
        kind: 'failed',
        code: observed.row.status !== 'active'
          ? 'azure-devops/review-target-state-changed'
          : observed.row.lastMergeTargetCommitId !== plan.baseRevision
            ? 'azure-devops/review-base-advanced'
            : 'azure-devops/review-head-advanced',
      },
    };
  }
  return { ok: true };
}

/**
 * The provider-owned markerless verdict seam. It deliberately does not reread the vote: an
 * identical current vote cannot prove which actor or frozen publication produced it. Only the
 * synchronous accepted response can settle published; answer loss remains uncertain forever.
 */
export async function publishAzureMarkerlessVote(input: Readonly<{
  mutation: AzureMutationContext;
  verdict: 'approve' | 'requestChanges';
}>): Promise<PublicationWrite> {
  const desiredVote = input.verdict === 'approve' ? 10 : -10;
  return normalizeWrite(await setAzurePullRequestReviewerVote({
    client: input.mutation.client,
    address: input.mutation.address,
    reviewerId: input.mutation.viewerId,
    vote: desiredVote,
    signal: input.mutation.signal,
  }));
}

async function executePublication(input: Readonly<{
  plan: ReviewCommentPublicationPlanV1;
  mode: PublicationMode;
  mutation: AzureMutationContext;
  context: PluginInvocationContext;
}>): Promise<AzureReviewPublicationResultV1> {
  const current = await observeAzureMutation(input.mutation);
  if (current.row === null) {
    return Object.freeze({
      kind: 'rejected', reason: 'admission-failed',
      ...(current.observation.kind === 'unresolved' ? { failure: current.observation.failure } : {}),
    });
  }
  if (current.row.status !== 'active') {
    return Object.freeze({ kind: 'rejected', reason: 'state-changed', observation: current.observation });
  }
  if (input.plan.baseRevision !== null
    && current.row.lastMergeTargetCommitId !== input.plan.baseRevision) {
    return Object.freeze({ kind: 'rejected', reason: 'base-advanced', observation: current.observation });
  }
  if (input.plan.headRevision !== null
    && current.row.lastMergeSourceCommitId !== input.plan.headRevision) {
    return Object.freeze({ kind: 'rejected', reason: 'head-advanced', observation: current.observation });
  }
  const routing = input.mode.kind === 'submit'
    ? preflightReviewCommentPublicationRoutingV1(input.plan)
    : null;
  if (routing?.kind === 'rejected') {
    return Object.freeze({ kind: 'rejected', reason: 'unsupported-anchor', observation: current.observation });
  }
  const summaryEntryIndexes = routing?.kind === 'ready'
    ? routing.verdictSummaryEntryIndexes
    : [];

  let contexts: readonly PublicationContext[] = [];
  if (input.mode.kind !== 'reply') {
    const needsInline = input.plan.entries.some((entry) => (
      entry.anchor.kind === 'file' || entry.anchor.kind === 'line' || entry.anchor.kind === 'range'
    ));
    let changed: Awaited<ReturnType<typeof readCurrentChangedFiles>> | null = null;
    if (needsInline && current.row.supportsIterations !== false) {
      changed = await readCurrentChangedFiles(input.mutation);
      if (!changed.ok) {
        return Object.freeze({
          kind: 'rejected', reason: 'unsupported-anchor', observation: current.observation,
          failure: projectAzureSourceFailure(changed.failure),
        });
      }
    }
    const resolved = input.plan.entries.map((entry, index): PublicationContext | null => {
      if (entry.anchor.kind === 'file' || entry.anchor.kind === 'line' || entry.anchor.kind === 'range') {
        return current.row!.supportsIterations === false
          ? legacyInlineContext(entry, input.plan)
          : changed !== null && changed.ok ? inlineContext(entry, input.plan, changed) : null;
      }
      if (summaryEntryIndexes.includes(index)
        || (input.mode.kind !== 'submit' && reviewCommentPublicationEntryIsDiffLessV1(entry))) {
        return summarySnapshotMatchesPlan(entry, input.plan) ? Object.freeze({}) : null;
      }
      return null;
    });
    if (resolved.some((value) => value === null)) {
      return Object.freeze({ kind: 'rejected', reason: 'unsupported-anchor', observation: current.observation });
    }
    contexts = resolved as readonly PublicationContext[];
  }

  const initialInventory = await readThreadInventory(input.mutation);
  if (!initialInventory.ok) {
    return Object.freeze({
      kind: 'rejected', reason: 'admission-failed', observation: current.observation,
      failure: initialInventory.failure,
    });
  }
  if (input.mode.kind === 'reply') {
    const parents = initialInventory.value.parentCommentIdsByThread.get(input.mode.threadId);
    if (parents === undefined || !parents.has(input.mode.parentCommentId)) {
      return Object.freeze({ kind: 'rejected', reason: 'thread-not-found', observation: current.observation });
    }
  }

  // Anchor/inventory reads may span several native pages. Recheck the exact target after those
  // reads and before consuming the durable claim.
  const preclaim = await observeAzureMutation(input.mutation);
  if (!revisionsMatch(input.plan, preclaim) || preclaim.row?.status !== 'active') {
    const reason = preclaim.row === null || preclaim.row.status !== 'active'
      ? 'state-changed'
      : preclaim.row.lastMergeTargetCommitId !== input.plan.baseRevision
        ? 'base-advanced'
        : 'head-advanced';
    return Object.freeze({ kind: 'rejected', reason, observation: preclaim.observation });
  }

  let claim: ReviewCommentClaimPublicationDispatchResponseV1;
  try {
    claim = await claimPlan(input.context, input.mutation, input.plan);
  } catch {
    return Object.freeze({ kind: 'rejected', reason: 'dispatch-claim-failed', observation: preclaim.observation });
  }

  const settle = async (
    entries: readonly ReviewCommentPublicationEntryResultV1[],
    verdict: ReviewCommentPublicationResultV1['verdict'],
    failure?: TriageSourceFailureV1,
  ): Promise<AzureReviewPublicationResultV1> => {
    const publication = validateReviewCommentPublicationResultAgainstPlanV1(input.plan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries,
      verdict,
    });
    const exact = await finalObservation(input.mutation);
    return Object.freeze({
      kind: 'settled', publication, ...exact,
      ...(failure === undefined ? {} : { failure }),
    });
  };

  if (claim.disposition === 'reconcile') {
    const inventory = await readThreadInventory(input.mutation);
    const complete = inventory.ok ? inventory.value : null;
    const entries = input.plan.entries.map((entry, index) => reconcileEntry(
      entry, claim.entries[index]!.publicationCorrelationId, complete,
      input.mode.kind === 'reply' ? input.mode.threadId : undefined,
    ));
    let verdict: ReviewCommentPublicationResultV1['verdict'];
    if (input.plan.verdict === null || claim.verdict === null) {
      verdict = Object.freeze({ kind: 'notRequested' as const });
    } else {
      const found = complete === null
        ? undefined
        : findMarker(complete, formatReviewCommentPublicationMarkerV1('verdict', claim.verdict.publicationCorrelationId));
      verdict = Object.freeze({
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: found === undefined || input.plan.verdict.kind !== 'comment'
          ? { kind: 'uncertain' as const }
          : { kind: 'published' as const, externalRef: found.externalRef },
      });
      if (found !== undefined && input.plan.verdict.kind !== 'comment') {
        verdict = Object.freeze({
          publicationCorrelationId: claim.verdict.publicationCorrelationId,
          outcome: { kind: 'uncertain' as const, externalRef: found.externalRef },
        });
      }
    }
    return await settle(entries, verdict, inventory.ok ? undefined : inventory.failure);
  }

  const entryResults: Array<ReviewCommentPublicationEntryResultV1 | undefined> =
    new Array(input.plan.entries.length);
  let stopped = false;
  let firstFailure: TriageSourceFailureV1 | undefined;
  for (let index = 0; index < input.plan.entries.length; index += 1) {
    const entry = input.plan.entries[index]!;
    const correlation = claim.entries[index]!;
    if (summaryEntryIndexes.includes(index)) continue;
    if (stopped) {
      entryResults[index] = Object.freeze({
        happierCommentId: entry.happierCommentId,
        publicationCorrelationId: correlation.publicationCorrelationId,
        outcome: { kind: 'skippedPriorFailure' as const },
      });
      continue;
    }
    const exactMarker = formatReviewCommentPublicationMarkerV1('entry', correlation.publicationCorrelationId);
    const before = await readThreadInventory(input.mutation);
    if (!before.ok) {
      entryResults[index] = Object.freeze({
        happierCommentId: entry.happierCommentId,
        publicationCorrelationId: correlation.publicationCorrelationId,
        outcome: { kind: 'uncertain' as const },
      });
      stopped = true;
      firstFailure ??= before.failure;
      continue;
    }
    const markerState = lookupMarker(
      before.value,
      exactMarker,
      input.mode.kind === 'reply' ? input.mode.threadId : undefined,
    );
    if (markerState.kind === 'duplicate') {
      entryResults[index] = Object.freeze({
        happierCommentId: entry.happierCommentId,
        publicationCorrelationId: correlation.publicationCorrelationId,
        outcome: { kind: 'uncertain' as const },
      });
      stopped = true;
      continue;
    }
    if (markerState.kind === 'unique') {
      entryResults[index] = Object.freeze({
        happierCommentId: entry.happierCommentId,
        publicationCorrelationId: correlation.publicationCorrelationId,
        outcome: { kind: 'published' as const, externalRef: markerState.comment.externalRef },
      });
      continue;
    }
    const effectAdmission = await admitPublicationEffect(input.mutation, input.plan);
    if (!effectAdmission.ok) {
      entryResults[index] = Object.freeze({
        happierCommentId: entry.happierCommentId,
        publicationCorrelationId: correlation.publicationCorrelationId,
        outcome: effectAdmission.outcome,
      });
      firstFailure ??= effectAdmission.failure;
      stopped = true;
      continue;
    }
    const content = `${entry.body}\n\n${exactMarker}`;
    const written = input.mode.kind === 'reply'
      ? normalizeCommentWrite(await createAzurePullRequestThreadReply({
        client: input.mutation.client, address: input.mutation.address,
        threadId: input.mode.threadId, parentCommentId: input.mode.parentCommentId,
        content, signal: input.mutation.signal,
      }))
      : normalizeCommentWrite(await createAzurePullRequestThread({
        client: input.mutation.client, address: input.mutation.address,
        body: threadBody(content, contexts[index]!), signal: input.mutation.signal,
      }));
    const after = await readThreadInventory(input.mutation);
    if (!after.ok) firstFailure ??= after.failure;
    const confirmation = after.ok
      ? lookupMarker(after.value, exactMarker, input.mode.kind === 'reply' ? input.mode.threadId : undefined)
      : null;
    const outcome = confirmation?.kind === 'unique'
      ? { kind: 'published' as const, externalRef: confirmation.comment.externalRef }
      : confirmation?.kind === 'duplicate'
        ? { kind: 'uncertain' as const }
        : written.kind === 'failed'
        ? failureOutcome(written.failure)
        : { kind: 'uncertain' as const };
    if (written.kind !== 'accepted') firstFailure ??= projectAzureSourceFailure(written.failure);
    entryResults[index] = Object.freeze({
      happierCommentId: entry.happierCommentId,
      publicationCorrelationId: correlation.publicationCorrelationId,
      outcome,
    });
    if (outcome.kind !== 'published') stopped = true;
  }

  if (stopped) {
    for (const index of summaryEntryIndexes) {
      const entry = input.plan.entries[index]!;
      entryResults[index] = Object.freeze({
        happierCommentId: entry.happierCommentId,
        publicationCorrelationId: claim.entries[index]!.publicationCorrelationId,
        outcome: { kind: 'skippedPriorFailure' as const },
      });
    }
  }

  let verdict: ReviewCommentPublicationResultV1['verdict'];
  if (input.plan.verdict === null || claim.verdict === null) {
    verdict = Object.freeze({ kind: 'notRequested' as const });
  } else if (stopped) {
    verdict = Object.freeze({
      publicationCorrelationId: claim.verdict.publicationCorrelationId,
      outcome: { kind: 'skippedPriorFailure' as const },
    });
  } else {
    // This is user-authored summary content, not a synthetic receipt. Azure's vote endpoint cannot
    // carry it, so it is a normal unanchored marked thread after the ordered entry prefix. For
    // approve/requestChanges the markerless vote follows only after the summary is confirmed.
    const exactMarker = formatReviewCommentPublicationMarkerV1('verdict', claim.verdict.publicationCorrelationId);
    const before = await readThreadInventory(input.mutation);
    const markerState = before.ok ? lookupMarker(before.value, exactMarker) : null;
    const existing = markerState?.kind === 'unique' ? markerState.comment : undefined;
    let summaryOutcome: Exclude<ReviewCommentPublicationResultV1['verdict'], { kind: 'notRequested' }>['outcome'];
    if (!before.ok || markerState?.kind === 'duplicate') {
      summaryOutcome = { kind: 'uncertain' };
    } else if (existing !== undefined) {
      summaryOutcome = { kind: 'published', externalRef: existing.externalRef };
    } else {
      const summaryAdmission = await admitPublicationEffect(input.mutation, input.plan);
      if (!summaryAdmission.ok) {
        summaryOutcome = summaryAdmission.outcome;
        firstFailure ??= summaryAdmission.failure;
      } else {
        const summaryParts = [
          ...summaryEntryIndexes.flatMap((index) => {
            const entry = input.plan.entries[index]!;
            return [entry.body, formatReviewCommentPublicationMarkerV1('entry', claim.entries[index]!.publicationCorrelationId)];
          }),
          input.plan.verdict.body,
          exactMarker,
        ];
        const written = normalizeCommentWrite(await createAzurePullRequestThread({
          client: input.mutation.client,
          address: input.mutation.address,
          body: threadBody(summaryParts.join('\n\n'), Object.freeze({})),
          signal: input.mutation.signal,
        }));
        const after = await readThreadInventory(input.mutation);
        if (!after.ok) firstFailure ??= after.failure;
        const confirmation = after.ok ? lookupMarker(after.value, exactMarker) : null;
        summaryOutcome = confirmation?.kind === 'unique'
          ? { kind: 'published', externalRef: confirmation.comment.externalRef }
          : confirmation?.kind === 'duplicate'
            ? { kind: 'uncertain' }
            : written.kind === 'failed'
              ? failureOutcome(written.failure)
              : { kind: 'uncertain' };
        if (written.kind !== 'accepted') firstFailure ??= projectAzureSourceFailure(written.failure);
      }
    }
    for (const index of summaryEntryIndexes) {
      const entry = input.plan.entries[index]!;
      const entryOutcome: ReviewCommentPublicationEntryResultV1['outcome'] =
        summaryOutcome.kind === 'published' && summaryOutcome.externalRef !== undefined
          ? { kind: 'published', externalRef: summaryOutcome.externalRef }
          : summaryOutcome.kind === 'failed'
            ? { kind: 'failed', code: summaryOutcome.code, ...(summaryOutcome.message === undefined ? {} : { message: summaryOutcome.message }) }
            : { kind: 'uncertain' };
      entryResults[index] = Object.freeze({
        happierCommentId: entry.happierCommentId,
        publicationCorrelationId: claim.entries[index]!.publicationCorrelationId,
        outcome: entryOutcome,
      });
    }
    let outcome = summaryOutcome;
    if (summaryOutcome.kind === 'published' && input.plan.verdict.kind !== 'comment') {
      const voteAdmission = await admitPublicationEffect(input.mutation, input.plan);
      if (!voteAdmission.ok) {
        outcome = {
          ...voteAdmission.outcome,
          ...(summaryOutcome.externalRef === undefined ? {} : { externalRef: summaryOutcome.externalRef }),
        };
        firstFailure ??= voteAdmission.failure;
      } else {
        const written = await publishAzureMarkerlessVote({
          mutation: input.mutation,
          verdict: input.plan.verdict.kind,
        });
        outcome = written.kind === 'accepted'
          ? summaryOutcome
          : written.kind === 'failed'
            ? { ...failureOutcome(written.failure), ...(summaryOutcome.externalRef === undefined ? {} : { externalRef: summaryOutcome.externalRef }) }
            : { kind: 'uncertain', ...(summaryOutcome.externalRef === undefined ? {} : { externalRef: summaryOutcome.externalRef }) };
        if (written.kind !== 'accepted') firstFailure ??= projectAzureSourceFailure(written.failure);
      }
    }
    verdict = Object.freeze({
      publicationCorrelationId: claim.verdict.publicationCorrelationId,
      outcome,
    });
  }
  const entries = entryResults.map((result) => {
    if (result === undefined) throw new Error('Azure publication did not settle every planned entry.');
    return result;
  });
  return await settle(entries, verdict, firstFailure);
}

async function runAction(
  input: unknown,
  context: PluginInvocationContext,
  mode: PublicationMode,
): Promise<AzureReviewPublicationResultV1> {
  const parsed = mode.kind === 'submit'
    ? AzureSubmitReviewInputV1Schema.safeParse(input)
    : mode.kind === 'comment'
      ? AzureThreadCommentCreateInputV1Schema.safeParse(input)
      : AzureThreadReplyInputV1Schema.safeParse(input);
  if (!parsed.success) return Object.freeze({ kind: 'rejected', reason: 'invalid-input' });
  const request = parsed.data;
  let plan: ReviewCommentPublicationPlanV1;
  try {
    plan = parseReviewCommentPublicationPlanV1(request.publicationPlan);
  } catch {
    return Object.freeze({ kind: 'rejected', reason: 'invalid-input' });
  }
  if (!targetMatches(plan, request, mode)) {
    return Object.freeze({ kind: 'rejected', reason: 'invalid-input' });
  }
  const admitted = await admitAzureMutation(request, context);
  if (!admitted.ok) {
    return Object.freeze({
      kind: 'rejected',
      reason: 'admission-failed',
      ...(admitted.result.kind === 'unavailable' ? { failure: admitted.result.failure } : {}),
    });
  }
  try {
    return await executePublication({ plan, mode, mutation: admitted.mutation, context });
  } finally {
    admitted.dispose();
  }
}

export async function submitAzureDevOpsPullRequestReview(
  input: unknown,
  context: PluginInvocationContext,
) {
  return await runAction(input, context, { kind: 'submit' });
}

export async function createAzureDevOpsPullRequestThreadComment(
  input: unknown,
  context: PluginInvocationContext,
) {
  return await runAction(input, context, { kind: 'comment' });
}

export async function replyAzureDevOpsPullRequestThread(
  input: unknown,
  context: PluginInvocationContext,
) {
  const parsed = AzureThreadReplyInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({ kind: 'rejected' as const, reason: 'invalid-input' as const });
  }
  return await runAction(input, context, {
    kind: 'reply',
    threadId: parsed.data.threadId,
    parentCommentId: parsed.data.parentCommentId,
  });
}
