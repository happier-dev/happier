import type {
  ReviewCommentClaimPublicationDispatchResponseV1,
  ReviewCommentPublicationEntryV1,
  ReviewCommentPublicationPlanV1,
  ReviewCommentPublicationResultV1,
} from '@happier-dev/plugin-sdk/reviews';
import {
  formatReviewCommentPublicationMarkerV1,
  matchReviewCommentPublicationMarkerV1,
  preflightReviewCommentPublicationRoutingV1,
  validateReviewCommentPublicationResultAgainstPlanV1,
} from '@happier-dev/plugin-sdk/reviews';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { BitbucketTriageApiClient } from '../apiClient.js';
import { walkBitbucketCollection } from '../collection.js';
import type { BitbucketTriageFailure } from '../failures.js';
import { buildBitbucketPullRequestUrl } from '../pullRequests.js';
import type { BitbucketEntryRouteV1 } from '../source/invocationAdmission.js';
import type { BitbucketEntryObservationV1 } from '../source/observeEntry.js';

type ProviderEffect = ReviewCommentPublicationResultV1['entries'][number]['outcome'];
type BitbucketVerdict = 'approved' | 'changes_requested';
type RequestedVerdict = BitbucketVerdict | 'comment';

type PublicationDependencies = Readonly<{
  client: BitbucketTriageApiClient;
  route: BitbucketEntryRouteV1;
  signal: AbortSignal;
  observe: () => Promise<BitbucketEntryObservationV1>;
  toTriageFailure: (failure: BitbucketTriageFailure) => TriageSourceFailureV1;
}>;

type SingleCommentMode = Readonly<
  | { kind: 'create' }
  | { kind: 'reply'; parentCommentId: string }
>;

export type BitbucketReviewPublicationOutcomeV1 =
  | Readonly<{
    kind: 'settled';
    publication: ReviewCommentPublicationResultV1;
    observation?: Extract<BitbucketEntryObservationV1['observation'], { kind: 'present' }>;
    failure?: TriageSourceFailureV1;
  }>
  | Readonly<{
    kind: 'rejected';
    reason: 'base_advanced' | 'head_advanced' | 'state_changed' | 'unsupported_verdict'
      | 'unsupported_anchor' | 'dispatch_claim_failed';
    observation?: Extract<BitbucketEntryObservationV1['observation'], { kind: 'present' }>;
    failure?: TriageSourceFailureV1;
  }>;

function commentsUrl(route: BitbucketEntryRouteV1): string {
  return `${buildBitbucketPullRequestUrl(route)}/comments`;
}

function verdictUrl(route: BitbucketEntryRouteV1, verdict: BitbucketVerdict): string {
  return `${buildBitbucketPullRequestUrl(route)}/${verdict === 'approved' ? 'approve' : 'request-changes'}`;
}

function externalId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = (raw as Readonly<Record<string, unknown>>).id;
  return typeof id === 'string' && id.length > 0
    ? id
    : typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : null;
}

function rawComment(raw: unknown): Readonly<{ externalRef: string; body: string }> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Readonly<Record<string, unknown>>;
  const ref = externalId(record);
  if (ref === null) return null;
  // A deleted tombstone is still enumerated by the provider and cannot carry a
  // marker, so it reads as an empty body — the same fact the Comments
  // projection publishes for the same row. Any OTHER unreadable body fails the
  // collection closed: treating malformed live content as empty could hide an
  // existing marker and duplicate an outward write.
  const content = record.content;
  const body = content !== null && typeof content === 'object' && !Array.isArray(content)
    ? (content as Readonly<Record<string, unknown>>).raw
    : undefined;
  return typeof body === 'string'
    ? { externalRef: ref, body }
    : record.deleted === true ? { externalRef: ref, body: '' } : null;
}

async function readMarkers(
  dependencies: PublicationDependencies,
  markers: readonly string[],
): Promise<
  | Readonly<{ ok: true; refs: ReadonlyMap<string, string> }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>
> {
  const walked = await walkBitbucketCollection({
    client: dependencies.client,
    url: commentsUrl(dependencies.route),
    decode: rawComment,
    signal: dependencies.signal,
  });
  if (!walked.ok) return walked;
  if (!walked.complete || walked.failure !== undefined) {
    return {
      ok: false,
      failure: walked.failure ?? {
        class: 'unsupportedContract',
        code: 'review-comment-reconciliation-incomplete',
      },
    };
  }
  const refs = new Map<string, string>();
  for (const marker of markers) {
    const match = matchReviewCommentPublicationMarkerV1(walked.items, marker);
    if (match.kind === 'duplicate') {
      return {
        ok: false,
        failure: { class: 'unsupportedContract', code: 'review-comment-marker-duplicate' },
      };
    }
    if (match.kind === 'unique') refs.set(marker, match.externalRef);
  }
  return { ok: true, refs };
}

function inlineForEntry(
  entry: ReviewCommentPublicationEntryV1,
  plan: ReviewCommentPublicationPlanV1,
): Readonly<Record<string, unknown>> | null {
  // Bitbucket's `from`/`to` identify one old/new diff line; they are not a
  // start/end range. A canonical range cannot be narrowed to its last line.
  if (entry.anchor.kind !== 'line'
    || entry.snapshot.kind !== 'text'
    || entry.snapshot.diffContext === undefined
    || plan.baseRevision === null
    || plan.headRevision === null
  ) return null;
  const diff = entry.snapshot.diffContext;
  if (diff.baseSha !== plan.baseRevision
    || diff.headSha !== plan.headRevision
    || (diff.startSha !== undefined && diff.startSha !== plan.baseRevision)
    || (entry.snapshot.commitSha !== undefined && entry.snapshot.commitSha !== plan.headRevision)
  ) return null;
  const line = entry.anchor.line;
  const side = entry.anchor.side ?? diff.side;
  return side === 'before'
    ? { path: entry.anchor.filePath, from: line }
    : { path: entry.anchor.filePath, to: line };
}

function verdictState(plan: ReviewCommentPublicationPlanV1): RequestedVerdict | null | undefined {
  if (plan.verdict === null) return null;
  if (plan.verdict.kind === 'approve') return 'approved';
  if (plan.verdict.kind === 'requestChanges') return 'changes_requested';
  if (plan.verdict.kind === 'comment') return 'comment';
  return undefined;
}

function failedOutcome(failure: BitbucketTriageFailure): ProviderEffect {
  return {
    kind: 'failed',
    code: failure.code,
  };
}

function isAmbiguous(failure: BitbucketTriageFailure): boolean {
  return failure.class === 'transient' || failure.class === 'cancelled';
}

async function writeComment(
  dependencies: PublicationDependencies,
  body: string,
  inline?: Readonly<Record<string, unknown>>,
  parentCommentId?: string,
): Promise<Readonly<{ ok: true; externalRef: string }> | Readonly<{ ok: false; failure: BitbucketTriageFailure }>> {
  const response = await dependencies.client.requestJson({
    url: commentsUrl(dependencies.route),
    method: 'POST',
    body: {
      content: { raw: body },
      ...(inline === undefined ? {} : { inline }),
      ...(parentCommentId === undefined ? {} : { parent: { id: parentCommentId } }),
    },
    signal: dependencies.signal,
  });
  if (!response.ok) return response;
  const ref = externalId(response.body);
  return ref === null
    // A successful status with an unreadable body still may have published the
    // comment. Treat it as answer-loss so the exact marker is reconciled and
    // the outward write is never repeated blindly.
    ? { ok: false, failure: { class: 'transient', code: 'review-comment-response-undecodable' } }
    : { ok: true, externalRef: ref };
}

async function reconcileOne(
  dependencies: PublicationDependencies,
  marker: string,
): Promise<Readonly<{ kind: 'found'; externalRef: string }> | Readonly<{ kind: 'missing' }> | Readonly<{
  kind: 'failed'; failure: BitbucketTriageFailure;
}>> {
  const read = await readMarkers(dependencies, [marker]);
  if (!read.ok) return { kind: 'failed', failure: read.failure };
  const ref = read.refs.get(marker);
  return ref === undefined ? { kind: 'missing' } : { kind: 'found', externalRef: ref };
}

async function reconcileSummary(
  dependencies: PublicationDependencies,
  markers: readonly string[],
): Promise<Readonly<{ kind: 'found'; externalRef: string }> | Readonly<{ kind: 'missing' }> | Readonly<{
  kind: 'failed'; failure: BitbucketTriageFailure;
}>> {
  const read = await readMarkers(dependencies, markers);
  if (!read.ok) return { kind: 'failed', failure: read.failure };
  const refs = markers.map((marker) => read.refs.get(marker));
  if (refs.every((ref) => ref === undefined)) return { kind: 'missing' };
  const first = refs[0];
  if (first !== undefined && refs.every((ref) => ref === first)) {
    return { kind: 'found', externalRef: first };
  }
  return {
    kind: 'failed',
    failure: { class: 'unsupportedContract', code: 'review-summary-marker-cardinality-mismatch' },
  };
}

/**
 * Publishes one standalone canonical proposal. A new inline comment is pinned
 * to the exact comparison; a reply is deliberately unversioned but preflights
 * the exact provider comment before the generic dispatch claim.
 */
export async function publishBitbucketReviewComment(
  input: Readonly<{
    plan: ReviewCommentPublicationPlanV1;
    mode: SingleCommentMode;
    claim: () => Promise<ReviewCommentClaimPublicationDispatchResponseV1>;
  }>,
  dependencies: PublicationDependencies,
): Promise<BitbucketReviewPublicationOutcomeV1> {
  const initial = await dependencies.observe();
  if (initial.observation.kind !== 'present') {
    return {
      kind: 'rejected',
      reason: 'state_changed',
      ...(initial.observation.kind === 'unresolved'
        ? { failure: initial.observation.failure }
        : {}),
    };
  }
  if (initial.state !== 'OPEN') {
    return { kind: 'rejected', reason: 'state_changed', observation: initial.observation };
  }
  const entry = input.plan.entries[0];
  if (input.plan.entries.length !== 1 || entry === undefined || input.plan.verdict !== null) {
    return { kind: 'rejected', reason: 'unsupported_anchor', observation: initial.observation };
  }

  let inline: Readonly<Record<string, unknown>> | undefined;
  if (input.mode.kind === 'create') {
    if (input.plan.baseRevision === null
      || initial.observation.snapshot.reviewRevision?.baseSha !== input.plan.baseRevision
    ) {
      return { kind: 'rejected', reason: 'base_advanced', observation: initial.observation };
    }
    if (input.plan.headRevision === null || initial.headCommit !== input.plan.headRevision) {
      return { kind: 'rejected', reason: 'head_advanced', observation: initial.observation };
    }
    const projected = inlineForEntry(entry, input.plan);
    if (projected === null) {
      return { kind: 'rejected', reason: 'unsupported_anchor', observation: initial.observation };
    }
    inline = projected;
  } else {
    if (input.plan.baseRevision !== null || input.plan.headRevision !== null) {
      return { kind: 'rejected', reason: 'unsupported_anchor', observation: initial.observation };
    }
    const parent = await dependencies.client.requestJson({
      url: `${commentsUrl(dependencies.route)}/${encodeURIComponent(input.mode.parentCommentId)}`,
      method: 'GET',
      signal: dependencies.signal,
    });
    if (!parent.ok || externalId(parent.body) !== input.mode.parentCommentId) {
      return {
        kind: 'rejected',
        reason: 'state_changed',
        observation: initial.observation,
        ...(!parent.ok ? { failure: dependencies.toTriageFailure(parent.failure) } : {}),
      };
    }
  }

  let claim: ReviewCommentClaimPublicationDispatchResponseV1;
  try {
    claim = await input.claim();
  } catch {
    return { kind: 'rejected', reason: 'dispatch_claim_failed', observation: initial.observation };
  }
  const correlation = claim.entries[0];
  if (correlation === undefined) {
    return { kind: 'rejected', reason: 'dispatch_claim_failed', observation: initial.observation };
  }
  const marker = formatReviewCommentPublicationMarkerV1('entry', correlation.publicationCorrelationId);
  const before = await reconcileOne(dependencies, marker);
  let outcome: ProviderEffect;
  let failure: TriageSourceFailureV1 | undefined;
  if (before.kind === 'found') {
    outcome = { kind: 'published', externalRef: before.externalRef };
  } else if (before.kind === 'failed' || claim.disposition === 'reconcile') {
    outcome = { kind: 'uncertain' };
    if (before.kind === 'failed') failure = dependencies.toTriageFailure(before.failure);
  } else {
    const written = await writeComment(
      dependencies,
      `${entry.body}\n\n${marker}`,
      inline,
      input.mode.kind === 'reply' ? input.mode.parentCommentId : undefined,
    );
    if (written.ok) {
      outcome = { kind: 'published', externalRef: written.externalRef };
    } else if (isAmbiguous(written.failure)) {
      const after = await reconcileOne(dependencies, marker);
      outcome = after.kind === 'found'
        ? { kind: 'published', externalRef: after.externalRef }
        : { kind: 'uncertain' };
      if (after.kind !== 'found') failure = dependencies.toTriageFailure(written.failure);
    } else {
      outcome = failedOutcome(written.failure);
      failure = dependencies.toTriageFailure(written.failure);
    }
  }

  const publication = validateReviewCommentPublicationResultAgainstPlanV1(input.plan, claim, {
    publicationPlanId: claim.publicationPlanId,
    entries: [{
      happierCommentId: entry.happierCommentId,
      publicationCorrelationId: correlation.publicationCorrelationId,
      outcome,
    }],
    verdict: { kind: 'notRequested' },
  });
  const latest = await dependencies.observe();
  return {
    kind: 'settled',
    publication,
    ...(latest.observation.kind === 'present' ? { observation: latest.observation } : {}),
    ...(failure !== undefined
      ? { failure }
      : latest.observation.kind === 'unresolved' ? { failure: latest.observation.failure } : {}),
  };
}

/** Ordered Bitbucket publication beneath the generic Reviews dispatch claim. */
export async function publishBitbucketReview(
  input: Readonly<{
    plan: ReviewCommentPublicationPlanV1;
    claim: () => Promise<ReviewCommentClaimPublicationDispatchResponseV1>;
  }>,
  dependencies: PublicationDependencies,
): Promise<BitbucketReviewPublicationOutcomeV1> {
  const initial = await dependencies.observe();
  if (initial.observation.kind !== 'present') {
    return {
      kind: 'rejected',
      reason: 'state_changed',
      ...(initial.observation.kind === 'unresolved'
        ? { failure: initial.observation.failure }
        : {}),
    };
  }
  if (initial.state !== 'OPEN') {
    return { kind: 'rejected', reason: 'state_changed', observation: initial.observation };
  }
  if (input.plan.baseRevision === null || initial.observation.snapshot.reviewRevision?.baseSha !== input.plan.baseRevision) {
    return { kind: 'rejected', reason: 'base_advanced', observation: initial.observation };
  }
  if (input.plan.headRevision === null || initial.headCommit !== input.plan.headRevision) {
    return { kind: 'rejected', reason: 'head_advanced', observation: initial.observation };
  }
  const requestedVerdict = verdictState(input.plan);
  if (requestedVerdict === undefined) {
    return { kind: 'rejected', reason: 'unsupported_verdict', observation: initial.observation };
  }
  const routing = preflightReviewCommentPublicationRoutingV1(input.plan);
  if (routing.kind === 'rejected') {
    return { kind: 'rejected', reason: 'unsupported_anchor', observation: initial.observation };
  }
  const summaryIndexes = routing.verdictSummaryEntryIndexes;
  const summaryIndexSet = new Set(summaryIndexes);
  const inline: readonly (Readonly<Record<string, unknown>> | 'summary' | null)[] =
    input.plan.entries.map((entry, index) => summaryIndexSet.has(index)
      ? 'summary'
      : inlineForEntry(entry, input.plan));

  let claim: ReviewCommentClaimPublicationDispatchResponseV1;
  try {
    claim = await input.claim();
  } catch {
    return { kind: 'rejected', reason: 'dispatch_claim_failed', observation: initial.observation };
  }

  const entries: Array<ReviewCommentPublicationResultV1['entries'][number] | undefined> =
    new Array(input.plan.entries.length);
  const settleEntry = (index: number, outcome: ProviderEffect): void => {
    const entry = input.plan.entries[index]!;
    const correlation = claim.entries[index]!;
    entries[index] = {
      happierCommentId: entry.happierCommentId,
      publicationCorrelationId: correlation.publicationCorrelationId,
      outcome,
    };
  };
  let stopped = false;
  let firstFailure: TriageSourceFailureV1 | undefined;
  for (let index = 0; index < input.plan.entries.length; index += 1) {
    const entry = input.plan.entries[index]!;
    const correlation = claim.entries[index]!;
    const projection = inline[index]!;
    if (stopped) {
      settleEntry(index, { kind: 'skippedPriorFailure' });
      continue;
    }
    if (projection === 'summary') continue;
    if (projection === null) {
      settleEntry(index, { kind: 'failed', code: 'anchor_unresolvable' });
      stopped = true;
      continue;
    }
    const marker = formatReviewCommentPublicationMarkerV1('entry', correlation.publicationCorrelationId);
    const before = await reconcileOne(dependencies, marker);
    if (before.kind === 'failed') {
      firstFailure ??= dependencies.toTriageFailure(before.failure);
      settleEntry(index, { kind: 'uncertain' });
      stopped = true;
      continue;
    }
    let outcome: ProviderEffect;
    if (before.kind === 'found') {
      outcome = { kind: 'published', externalRef: before.externalRef };
    } else if (claim.disposition === 'reconcile') {
      outcome = { kind: 'uncertain' };
      stopped = true;
    } else {
      const written = await writeComment(
        dependencies,
        `${entry.body}\n\n${marker}`,
        projection,
      );
      if (written.ok) {
        outcome = { kind: 'published', externalRef: written.externalRef };
      } else if (isAmbiguous(written.failure)) {
        const after = await reconcileOne(dependencies, marker);
        if (after.kind === 'found') outcome = { kind: 'published', externalRef: after.externalRef };
        else {
          outcome = { kind: 'uncertain' };
          firstFailure ??= dependencies.toTriageFailure(written.failure);
          stopped = true;
        }
      } else {
        outcome = failedOutcome(written.failure);
        firstFailure ??= dependencies.toTriageFailure(written.failure);
        stopped = true;
      }
    }
    settleEntry(index, outcome);
  }

  if (stopped) {
    for (const index of summaryIndexes) {
      if (entries[index] === undefined) settleEntry(index, { kind: 'skippedPriorFailure' });
    }
  }

  let verdict: ReviewCommentPublicationResultV1['verdict'];
  if (requestedVerdict === null || input.plan.verdict === null || claim.verdict === null) {
    verdict = { kind: 'notRequested' };
  } else if (stopped) {
    verdict = {
      publicationCorrelationId: claim.verdict.publicationCorrelationId,
      outcome: { kind: 'skippedPriorFailure' },
    };
  } else {
    const marker = formatReviewCommentPublicationMarkerV1('verdict', claim.verdict.publicationCorrelationId);
    const foldedEntries = summaryIndexes.map((index) => ({
      index,
      entry: input.plan.entries[index]!,
      marker: formatReviewCommentPublicationMarkerV1('entry', claim.entries[index]!.publicationCorrelationId),
    }));
    const summaryMarkers = [...foldedEntries.map((folded) => folded.marker), marker];
    const before = await reconcileSummary(dependencies, summaryMarkers);
    let summaryRef = before.kind === 'found' ? before.externalRef : null;
    const summaryReconciliationFailed = before.kind === 'failed';
    let summaryFailure: BitbucketTriageFailure | undefined = before.kind === 'failed'
      ? before.failure
      : undefined;
    if (summaryRef === null && summaryFailure === undefined && claim.disposition === 'dispatch') {
      const summary = await writeComment(dependencies, [
        ...foldedEntries.map((folded) => `${folded.entry.body}\n\n${folded.marker}`),
        `${input.plan.verdict.body}\n\n${marker}`,
      ].join('\n\n'));
      if (summary.ok) summaryRef = summary.externalRef;
      else if (isAmbiguous(summary.failure)) {
        const after = await reconcileSummary(dependencies, summaryMarkers);
        if (after.kind === 'found') summaryRef = after.externalRef;
        else summaryFailure = summary.failure;
      } else summaryFailure = summary.failure;
    }
    const summaryEffect: ProviderEffect = summaryFailure !== undefined
      ? summaryReconciliationFailed
        || claim.disposition === 'reconcile'
        || isAmbiguous(summaryFailure)
        ? { kind: 'uncertain' }
        : failedOutcome(summaryFailure)
      : summaryRef === null
        ? { kind: 'uncertain' }
        : { kind: 'published', externalRef: summaryRef };
    for (const folded of foldedEntries) settleEntry(folded.index, summaryEffect);
    if (summaryFailure !== undefined) {
      firstFailure ??= dependencies.toTriageFailure(summaryFailure);
      verdict = {
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: summaryReconciliationFailed
          || claim.disposition === 'reconcile'
          || isAmbiguous(summaryFailure)
          ? { kind: 'uncertain' }
          : failedOutcome(summaryFailure),
      };
    } else if (summaryRef === null) {
      verdict = {
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: { kind: 'uncertain' },
      };
    } else if (requestedVerdict === 'comment') {
      verdict = {
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: { kind: 'published', externalRef: summaryRef },
      };
    } else if (claim.disposition === 'reconcile') {
      // The summary marker is correlated; Bitbucket's verdict endpoint is not.
      // Never attribute a matching participant state to this invocation.
      verdict = {
        publicationCorrelationId: claim.verdict.publicationCorrelationId,
        outcome: { kind: 'uncertain', externalRef: summaryRef },
      };
    } else {
      const current = await dependencies.observe();
      if (current.observation.kind !== 'present'
        || current.state !== 'OPEN'
        || current.observation.snapshot.reviewRevision?.baseSha !== input.plan.baseRevision
        || current.headCommit !== input.plan.headRevision
      ) {
        verdict = {
          publicationCorrelationId: claim.verdict.publicationCorrelationId,
          outcome: {
            kind: 'failed',
            code: 'review-currentness-changed',
            externalRef: summaryRef,
          },
        };
      } else {
        const written = await dependencies.client.requestJson({
          url: verdictUrl(dependencies.route, requestedVerdict),
          method: 'POST',
          signal: dependencies.signal,
        });
        if (!written.ok) {
          firstFailure ??= dependencies.toTriageFailure(written.failure);
          verdict = {
            publicationCorrelationId: claim.verdict.publicationCorrelationId,
            outcome: isAmbiguous(written.failure)
              ? { kind: 'uncertain', externalRef: summaryRef }
              : { kind: 'failed', code: written.failure.code, externalRef: summaryRef },
          };
        } else {
          const confirmed = await dependencies.observe();
          verdict = {
            publicationCorrelationId: claim.verdict.publicationCorrelationId,
            outcome: confirmed.observation.kind === 'present'
              && confirmed.viewerReviewVerdict === requestedVerdict
              ? { kind: 'published', externalRef: summaryRef }
              : { kind: 'uncertain', externalRef: summaryRef },
          };
        }
      }
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index] === undefined) settleEntry(index, { kind: 'skippedPriorFailure' });
  }

  const publication = validateReviewCommentPublicationResultAgainstPlanV1(input.plan, claim, {
    publicationPlanId: claim.publicationPlanId,
    entries: entries as ReviewCommentPublicationResultV1['entries'],
    verdict,
  });
  const latest = await dependencies.observe();
  return {
    kind: 'settled',
    publication,
    ...(latest.observation.kind === 'present' ? { observation: latest.observation } : {}),
    ...(firstFailure === undefined
      ? latest.observation.kind === 'unresolved' ? { failure: latest.observation.failure } : {}
      : { failure: firstFailure }),
  };
}
