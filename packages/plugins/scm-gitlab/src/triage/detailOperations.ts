/**
 * The bound source-native GitLab detail operations.
 *
 * Each is the whole vertical for one Action invocation: it validates the
 * published input, admits the configured deployment through the SAME rule `scan`
 * and `get` use, resolves the project from the collision scope this source
 * minted, materializes that exact account inside one request closure, and shapes
 * the result into the published contract. It owns no registry, no cache, no
 * second route authority, and it writes no configured state.
 *
 * The detail body invokes these; it never holds a credential, constructs a URL,
 * or sees a raw provider body. What crosses back is only what the boundary
 * projector copied.
 *
 * Every failure is a STATED outcome rather than an empty result. A discussions
 * read refused for permission, a pipeline whose per-job breakdown could not be
 * read, and a merge request with no pipelines at all are three different
 * answers, and each panel is given the one that is true.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
  TriagePullRequestStatusV1,
  TriagePullRequestStatusResultV1,
} from '@happier-dev/triage-protocol/v1';
import { TriageGetInputV1Schema, TriagePullRequestStatusResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageIdentifierV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  fitActionResultPageV1,
  fitActionResultSequenceV1,
} from '@happier-dev/triage-sources/projection/actionResultSequence';
import { fitActionResultTextV1 } from '@happier-dev/triage-sources/projection/actionResultText';

import { admitGitlabItemIdentity, admitGitlabItemInvocation } from './admission.js';
import {
  GitlabActivityEventsInputV1Schema,
  GitlabApprovalsInputV1Schema,
  GitlabChangesInputV1Schema,
  GitlabDiscussionsInputV1Schema,
  GitlabNotesInputV1Schema,
  GitlabOverviewInputV1Schema,
  GitlabOverviewResultV1Schema,
  GitlabPipelinesInputV1Schema,
  GitlabRawDiffInputV1Schema,
  type GitlabActivityEventsResultV1,
  type GitlabApprovalsResultV1,
  type GitlabChangesResultV1,
  type GitlabDiscussionsResultV1,
  type GitlabNotesResultV1,
  type GitlabOverviewResultV1,
  type GitlabPipelinesResultV1,
  type GitlabRawDiffResultV1,
} from './detail/contracts.js';
import {
  decodeGitlabDetailContinuation,
  encodeGitlabDetailContinuation,
  type GitlabDetailContinuationPlaneV1,
  type GitlabDetailContinuationProvenanceV1,
} from './detail/continuation.js';
import { GITLAB_MAX_DETAIL_PAGE_SIZE_V1, type GitlabDetailRouteInputV1 } from './detail/routes.js';
import { boundGitlabText } from './mapping/bounded.js';
import {
  readGitlabActivityEventsPage,
  readGitlabApprovalsSurface,
  readGitlabChangesPage,
  readGitlabDiscussionsPage,
  readGitlabNotesPage,
  readGitlabPipelinesPage,
  readGitlabRawDiffText,
  type GitlabDetailPagePositionV1,
  type GitlabWalkPositionV1,
} from './detail/reads.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';
import { createGitlabHttpFetcher, readGitlabConnectedAccounts } from './invocation.js';
import { readGitlabTriageEntryForOverview } from './sourceGet.js';
import { readGitlabComparisonPage } from './detail/comparison.js';

const INVALID_INPUT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-detail-input-invalid',
});

const CONTINUATION_UNREADABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-detail-continuation-unreadable',
});

type GitlabApprovalRulesResultV1 = Extract<
  GitlabApprovalsResultV1,
  Readonly<{ kind: 'approvals' }>
>['rules'];

/* ------------------------------------------------------------------ overview */

export async function readGitlabOverview(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabOverviewResultV1> {
  const parsed = GitlabOverviewInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const read = await readGitlabTriageEntryForOverview({
    get: {
      v: 1,
      instance: request.instance,
      localRef: request.localRef,
      lastKnownLocator: { v: 1, routingToken: request.routingToken },
    },
    connectedAccounts: readGitlabConnectedAccounts(context),
    fetcher: createGitlabHttpFetcher(context),
    signal: context.signal,
    nowMs: Date.now(),
  });
  if (read.result.kind !== 'present') {
    return unavailable('failure' in read.result
      ? read.result.failure
      : { class: 'unknown', code: 'gitlab-overview-not-observed' });
  }

  const base = {
    kind: 'overview' as const,
    observedAtMs: Date.now(),
    observation: read.result,
  };
  if (read.description === null) {
    return GitlabOverviewResultV1Schema.parse({
      ...base,
      descriptionTruncated: false,
    });
  }
  return fitActionResultTextV1(read.description, (description, descriptionTruncated) => ({
    ...base,
    description,
    descriptionTruncated,
  }));
}

function unavailable(failure: TriageSourceFailureV1): Readonly<{
  kind: 'unavailable';
  failure: TriageSourceFailureV1;
}> {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

/** Expanded-row demand reuses the exact Overview read and its admitted request closure. */
export async function readGitlabPullRequestStatus(input: unknown, context: PluginInvocationContext): Promise<TriagePullRequestStatusResultV1> {
  const parsed = TriageGetInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const identity = admitGitlabItemIdentity({ localRef: parsed.data.localRef, admissibleKinds: ['merge-request'] });
  if (!identity.ok) return unavailable(identity.failure);
  const read = await readGitlabTriageEntryForOverview({
    get: parsed.data, connectedAccounts: readGitlabConnectedAccounts(context),
    fetcher: createGitlabHttpFetcher(context), signal: context.signal, nowMs: Date.now(),
  });
  if (read.result.kind !== 'present' || read.pullRequest === null || read.readContext === null) {
    return unavailable('failure' in read.result ? read.result.failure : { class: 'unknown', code: 'gitlab-status-not-observed' });
  }
  const { route, dependencies } = read.readContext;
  const [pipelines, approvals] = await Promise.all([
    readGitlabPipelinesPage({ route, perPage: GITLAB_MAX_DETAIL_PAGE_SIZE_V1, position: { kind: 'first' } }, dependencies),
    readGitlabApprovalsSurface({ route }, dependencies),
  ]);
  let checks: TriagePullRequestStatusV1['checks'] = null;
  if (pipelines.ok) {
    const { jobs, rollup } = pipelines.value;
    checks = {
      state: jobs.incomplete ? (jobs.rows.length > 0 ? 'incomplete' : 'unknown')
        : jobs.rows.some((row) => row.state === 'unknown') ? 'unknown'
          : jobs.total === 0 ? 'none' : 'complete',
      passed: rollup?.passingCount ?? (jobs.total === 0 ? 0 : null),
      failed: rollup?.failingCount ?? (jobs.total === 0 ? 0 : null),
      pending: rollup?.runningCount ?? (jobs.total === 0 ? 0 : null),
      total: jobs.total, rows: [...jobs.rows], incomplete: jobs.incomplete,
    };
  }
  let review: TriagePullRequestStatusV1['review'] = null;
  let textTruncated = read.pullRequest.projectionTruncated || read.result.snapshot.projectionTruncated === true
    || (pipelines.ok && pipelines.value.jobs.projectionTruncated);
  if (approvals.ok) {
    const { state } = approvals.value;
    const approvedBy = state.approvedBy.map((name) => boundGitlabText(name));
    const approvedNames = new Set(state.approvedBy);
    const pendingReviewers = read.pullRequest.reviewers.filter((name) => !approvedNames.has(name)).map((name) => boundGitlabText(name));
    textTruncated ||= [...approvedBy, ...pendingReviewers].some((name) => name.truncated);
    const reviewers: NonNullable<TriagePullRequestStatusV1['review']>['reviewers'][number][] = [];
    const appendReviewer = (nativeName: string, name: string, verb: 'approved' | 'pending') => {
      const id = TriageIdentifierV1ProtocolSchema.safeParse(`user:${nativeName}`);
      if (!id.success) { textTruncated = true; return; }
      reviewers.push({ id: id.data, name, verb });
    };
    state.approvedBy.forEach((name, index) => appendReviewer(name, approvedBy[index]!.text, 'approved'));
    read.pullRequest.reviewers.filter((name) => !approvedNames.has(name))
      .forEach((name, index) => appendReviewer(name, pendingReviewers[index]!.text, 'pending'));
    review = {
      decision: read.pullRequest.changesRequested ? 'changesRequested'
        : state.approvalsLeft !== undefined && state.approvalsLeft > 0 ? 'reviewRequired'
          : state.approvalsLeft === 0 && ((state.approvalsRequired ?? 0) > 0 || state.approvedBy.length > 0) ? 'approved' : null,
      reviewers,
      incomplete: state.omittedApproverCount > 0 || reviewers.length < approvedBy.length + pendingReviewers.length,
    };
  } else if (read.pullRequest.changesRequested) {
    review = { decision: 'changesRequested', reviewers: [], incomplete: true };
  }
  const base: TriagePullRequestStatusV1 = {
    kind: 'status', observedAtMs: Date.now(), checks, review,
    merge: read.pullRequest.merge, branch: read.pullRequest.branch, facts: read.result.snapshot.facts,
  };
  const candidates = [
    ...(checks?.rows.map((value) => ({ kind: 'check' as const, value })) ?? []),
    ...(review?.reviewers.map((value) => ({ kind: 'reviewer' as const, value })) ?? []),
  ];
  return TriagePullRequestStatusResultV1Schema.parse(fitActionResultSequenceV1(candidates, (included, omitted) => {
    const checkRows = included.filter((item) => item.kind === 'check').map((item) => item.value);
    const reviewers = included.filter((item) => item.kind === 'reviewer').map((item) => item.value);
    const checksOmitted = checks !== null && checkRows.length < checks.rows.length;
    return {
      ...base,
      checks: checks === null ? null : { ...checks, rows: checkRows,
        state: checksOmitted ? 'incomplete' as const : checks.state, incomplete: checks.incomplete || checksOmitted },
      review: review === null ? null : { ...review, reviewers, incomplete: review.incomplete || reviewers.length < review.reviewers.length },
      ...(textTruncated || omitted > 0 ? { projectionTruncated: true as const } : {}),
    };
  }).result);
}

/**
 * Resolves where one paged read starts.
 *
 * A continuation this source did not mint, one minted under a different window,
 * or one naming a URL outside the invoked origin is refused rather than
 * reinterpreted: resuming at a position that names different rows would silently
 * skip or repeat part of the collection.
 */
function resolvePosition(
  continuation: string | undefined,
  route: GitlabDetailRouteInputV1,
  limit: number,
  provenance: GitlabDetailContinuationProvenanceV1,
): Readonly<{ ok: true; position: GitlabDetailPagePositionV1 }> | Readonly<{ ok: false }> {
  if (continuation === undefined) {
    return Object.freeze({ ok: true as const, position: Object.freeze({ kind: 'first' as const }) });
  }
  const frontier = decodeGitlabDetailContinuation({
    token: continuation,
    origin: route.origin,
    limit,
    provenance,
  });
  if (frontier === null) return Object.freeze({ ok: false as const });
  return Object.freeze({
    ok: true as const,
    position: Object.freeze({ kind: 'continued' as const, nextUrl: frontier.nextUrl }),
  });
}

type PagedShape = Readonly<{
  incomplete?: 'pagination';
  continuation?: string;
}>;

/** Mints the provider position once so the canonical Action-envelope fitter can admit it. */
function mintWalkContinuation(
  page: GitlabWalkPositionV1,
  limit: number,
  provenance: GitlabDetailContinuationProvenanceV1,
): string | undefined {
  if (page.nextUrl === null) return undefined;
  return encodeGitlabDetailContinuation({ nextUrl: page.nextUrl, limit, provenance }) ?? undefined;
}

function detailContinuationProvenance(
  request: Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    localRef: TriageSourceEntryLocalRefV1;
    routingToken: string;
  }>,
  route: GitlabDetailRouteInputV1,
  plane: GitlabDetailContinuationPlaneV1,
): GitlabDetailContinuationProvenanceV1 {
  return Object.freeze({
    plane,
    sourceInstanceId: request.instance.instance.sourceInstanceId,
    configuredBaseUrl: route.origin.normalized,
    routingToken: request.routingToken,
    kindId: request.localRef.kindId,
    collisionScope: request.localRef.collisionScope,
    entryId: request.localRef.entryId,
  });
}

/** Shapes one settled walk position into the members every paged plane shares. */
function shapeWalkPosition(
  page: GitlabWalkPositionV1,
  continuation: string | undefined,
  continuationOmitted: boolean,
): PagedShape {
  // A next page this source cannot mint a token for ends the walk, and saying so
  // is the point. The Action fitter can also omit an oversized opaque token; that
  // has the same honest pagination outcome without a provider-local byte ceiling.
  const incomplete = page.incomplete
    ?? (page.nextUrl !== null && (continuation === undefined || continuationOmitted)
      ? 'pagination'
      : null);
  return Object.freeze({
    ...(incomplete === null ? {} : { incomplete }),
    ...(continuation === undefined ? {} : { continuation }),
  });
}

/* --------------------------------------------------------------------- notes */

/**
 * One bounded page of the notes of a merge request or an issue.
 *
 * It is the merge request's `Activity` note half and the issue's `Comments` tab:
 * one GitLab collection, read through the item segment its kind names, at the
 * window that tab declares.
 */
async function listGitlabNotesUnbounded(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabNotesResultV1> {
  const parsed = GitlabNotesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGitlabItemInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['merge-request', 'issue'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const provenance = detailContinuationProvenance(request, admitted.route, 'notes');
  const position = resolvePosition(request.continuation, admitted.route, request.limit, provenance);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const page = await readGitlabNotesPage({
    route: admitted.route,
    perPage: request.limit,
    position: position.position,
  }, admitted.dependencies);
  if (!page.ok) return unavailable(projectGitlabSourceFailure(page.failure));

  const continuation = mintWalkContinuation(page.value, request.limit, provenance);
  return fitActionResultPageV1(page.value.rows, continuation, (
    rows,
    omittedByEnvelope,
    fittedContinuation,
    continuationOmitted,
  ) => Object.freeze({
    kind: 'notes' as const,
    rows,
    omittedRowCount: page.value.omittedRowCount + omittedByEnvelope,
    projectionTruncated: page.value.projectionTruncated || omittedByEnvelope > 0,
    ...shapeWalkPosition(page.value, fittedContinuation, continuationOmitted),
  })).result;
}

/* ------------------------------------------------------------ activity events */

/**
 * One bounded page of ONE activity event source.
 *
 * The three sources each get their own invocation and their own continuation.
 * That is the divergence `sources/SCM.md` §4.6 fixes: a shared cursor would
 * advance label events because the reader asked for more state events, and the
 * union would then be missing the rows nobody skipped on purpose.
 */
async function listGitlabActivityEventsUnbounded(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabActivityEventsResultV1> {
  const parsed = GitlabActivityEventsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGitlabItemInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['merge-request', 'issue'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const provenance = detailContinuationProvenance(
    request,
    admitted.route,
    `activity:${request.eventSource}`,
  );
  const position = resolvePosition(request.continuation, admitted.route, request.limit, provenance);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const page = await readGitlabActivityEventsPage({
    route: admitted.route,
    source: request.eventSource,
    perPage: request.limit,
    position: position.position,
  }, admitted.dependencies);
  if (!page.ok) return unavailable(projectGitlabSourceFailure(page.failure));

  const continuation = mintWalkContinuation(page.value, request.limit, provenance);
  return fitActionResultPageV1(page.value.rows, continuation, (
    rows,
    omittedByEnvelope,
    fittedContinuation,
    continuationOmitted,
  ) => Object.freeze({
    kind: 'activityEvents' as const,
    source: request.eventSource,
    rows,
    omittedRowCount: page.value.omittedRowCount + omittedByEnvelope,
    projectionTruncated: page.value.projectionTruncated || omittedByEnvelope > 0,
    ...shapeWalkPosition(page.value, fittedContinuation, continuationOmitted),
  })).result;
}

/* --------------------------------------------------------------- discussions */

/** One bounded page of the discussion threads of a merge request. */
async function listGitlabDiscussionsUnbounded(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabDiscussionsResultV1> {
  const parsed = GitlabDiscussionsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGitlabItemInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    // An issue has discussions too, but the `Reviews` tab is a merge-request
    // composition; the issue vertical reads its notes collection instead.
    admissibleKinds: ['merge-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const provenance = detailContinuationProvenance(request, admitted.route, 'discussions');
  const position = resolvePosition(request.continuation, admitted.route, request.limit, provenance);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const page = await readGitlabDiscussionsPage({
    route: admitted.route,
    perPage: request.limit,
    position: position.position,
  }, admitted.dependencies);
  if (!page.ok) return unavailable(projectGitlabSourceFailure(page.failure));

  const continuation = mintWalkContinuation(page.value, request.limit, provenance);
  return fitActionResultPageV1(page.value.rows, continuation, (
    rows,
    omittedByEnvelope,
    fittedContinuation,
    continuationOmitted,
  ) => Object.freeze({
    kind: 'discussions' as const,
    rows,
    omittedRowCount: page.value.omittedRowCount + omittedByEnvelope,
    projectionTruncated: page.value.projectionTruncated || omittedByEnvelope > 0,
    ...shapeWalkPosition(page.value, fittedContinuation, continuationOmitted),
  })).result;
}

/* ----------------------------------------------------------------- approvals */

/**
 * The approval surface of one merge request, at every GitLab tier.
 *
 * The approve verb and the basic approval state are `Tier: Free, Premium,
 * Ultimate`. Only the rule-aware detail is Premium, and it degrades on its own
 * to `editionUnsupported` — so a Free-tier reader gets a working tab instead of
 * one that reports the whole feature as unavailable.
 */
async function readGitlabApprovalsUnbounded(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabApprovalsResultV1> {
  const parsed = GitlabApprovalsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGitlabItemInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['merge-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const read = await readGitlabApprovalsSurface({ route: admitted.route }, admitted.dependencies);
  if (!read.ok) return unavailable(projectGitlabSourceFailure(read.failure));

  const { state, rules } = read.value;
  const shape = (
    approvedBy: readonly string[],
    omittedApproverCount: number,
    rulesResult: GitlabApprovalRulesResultV1,
    projectionTruncated: boolean,
  ): GitlabApprovalsResultV1 => Object.freeze({
    kind: 'approvals' as const,
    ...(state.approvalsRequired === undefined ? {} : { approvalsRequired: state.approvalsRequired }),
    ...(state.approvalsLeft === undefined ? {} : { approvalsLeft: state.approvalsLeft }),
    approvedBy,
    omittedApproverCount,
    ...(state.userHasApproved === undefined ? {} : { userHasApproved: state.userHasApproved }),
    ...(state.userCanApprove === undefined ? {} : { userCanApprove: state.userCanApprove }),
    rules: rulesResult,
    projectionTruncated,
  });

  if (rules.kind !== 'available') {
    const unavailableRules: GitlabApprovalRulesResultV1 = rules.kind === 'editionUnsupported'
      ? Object.freeze({ kind: 'editionUnsupported' as const })
      : Object.freeze({
        kind: 'unavailable' as const,
        failure: projectGitlabSourceFailure(rules.failure),
      });
    return fitActionResultSequenceV1(state.approvedBy, (approvedBy, omittedByEnvelope) => shape(
      approvedBy,
      state.omittedApproverCount + omittedByEnvelope,
      unavailableRules,
      state.omittedApproverCount > 0 || omittedByEnvelope > 0,
    )).result;
  }

  // Fit the two independent provider sequences without inventing a count. A
  // single ordered sequence is important: fitting approvers against an empty
  // rules shape and then adding rules could make the final result exceed the
  // envelope. Approvers come first because that state exists on every tier;
  // rule-aware detail consumes only the remaining canonical Action envelope.
  const candidates = Object.freeze([
    ...state.approvedBy.map((value) => Object.freeze({ kind: 'approver' as const, value })),
    ...rules.rules.map((value) => Object.freeze({ kind: 'rule' as const, value })),
  ]);
  return fitActionResultSequenceV1(candidates, (included) => {
    const approvedBy = included
      .filter((candidate) => candidate.kind === 'approver')
      .map((candidate) => candidate.value);
    const fittedRules = included
      .filter((candidate) => candidate.kind === 'rule')
      .map((candidate) => candidate.value);
    const omittedApproverCount = state.omittedApproverCount
      + state.approvedBy.length - approvedBy.length;
    const omittedRuleCount = rules.omittedRuleCount + rules.rules.length - fittedRules.length;
    return shape(
      approvedBy,
      omittedApproverCount,
      Object.freeze({
        kind: 'available' as const,
        rules: fittedRules,
        omittedRuleCount,
      }),
      rules.projectionTruncated
        || state.omittedApproverCount > 0
        || omittedApproverCount > state.omittedApproverCount
        || omittedRuleCount > rules.omittedRuleCount,
    );
  }).result;
}

/* ----------------------------------------------------------------- pipelines */

/**
 * One bounded page of the pipelines of a merge request, plus the newest
 * pipeline's per-job rollup when GitLab supplied one.
 *
 * The three counts are omitted together or present together. A partial rollup
 * would be a number the reader cannot interpret, and a zeroed one would be a
 * number they would trust.
 */
async function listGitlabPipelinesUnbounded(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabPipelinesResultV1> {
  const parsed = GitlabPipelinesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGitlabItemInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['merge-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const provenance = detailContinuationProvenance(request, admitted.route, 'pipelines');
  const position = resolvePosition(request.continuation, admitted.route, request.limit, provenance);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const page = await readGitlabPipelinesPage({
    route: admitted.route,
    perPage: request.limit,
    position: position.position,
  }, admitted.dependencies);
  if (!page.ok) return unavailable(projectGitlabSourceFailure(page.failure));

  const { rollup, rollupPipelineId } = page.value;
  const continuation = mintWalkContinuation(page.value, request.limit, provenance);
  return fitActionResultPageV1(page.value.rows, continuation, (
    rows,
    omittedByEnvelope,
    fittedContinuation,
    continuationOmitted,
  ) => Object.freeze({
    kind: 'pipelines' as const,
    rows,
    ...(rollup === null
      ? {}
      : {
        failingCount: rollup.failingCount,
        runningCount: rollup.runningCount,
        passingCount: rollup.passingCount,
      }),
    ...(rollupPipelineId === null ? {} : { rollupPipelineId }),
    omittedRowCount: page.value.omittedRowCount + omittedByEnvelope,
    projectionTruncated: page.value.projectionTruncated || omittedByEnvelope > 0,
    ...shapeWalkPosition(page.value, fittedContinuation, continuationOmitted),
  })).result;
}

/* ------------------------------------------------------------------- changes */

/**
 * One `/diffs` page of a merge request: a whole number of files, with GitLab's
 * own per-file truncation evidence carried through unmodified.
 *
 * `diffLimitStatus` is the tab's honesty: `unknown` means the deployment did not
 * supply the 18.4 truncation fields, so no whole-diff claim is made. It is never
 * upgraded to `reported` by a projector that filled the gap with `false`.
 */
async function listGitlabChangesUnbounded(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabChangesResultV1> {
  const parsed = GitlabChangesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGitlabItemInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['merge-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const provenance = detailContinuationProvenance(request, admitted.route, 'changes');
  const position = resolvePosition(request.continuation, admitted.route, request.limit, provenance);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);
  if (request.comparison === true) return readGitlabComparisonPage(request, admitted, provenance, position.position);
  if (request.continuation !== undefined && decodeGitlabDetailContinuation({ token: request.continuation,
    origin: admitted.route.origin, limit: request.limit, provenance })?.comparison !== undefined) {
    return unavailable(CONTINUATION_UNREADABLE_FAILURE);
  }

  const page = await readGitlabChangesPage({
    route: admitted.route,
    perPage: request.limit,
    position: position.position,
  }, admitted.dependencies);
  if (!page.ok) return unavailable(projectGitlabSourceFailure(page.failure));

  const continuation = mintWalkContinuation(page.value, request.limit, provenance);
  return fitActionResultPageV1(page.value.rows, continuation, (
    rows,
    omittedByEnvelope,
    fittedContinuation,
    continuationOmitted,
  ) => Object.freeze({
    kind: 'changes' as const,
    rows,
    diffLimitStatus: page.value.diffLimitStatus,
    omittedRowCount: page.value.omittedRowCount + omittedByEnvelope,
    projectionTruncated: page.value.projectionTruncated || omittedByEnvelope > 0,
    ...shapeWalkPosition(page.value, fittedContinuation, continuationOmitted),
  })).result;
}

/* --------------------------------------------------------------- raw diff */

/**
 * GitLab's raw diff is an explicit evidence read, never a structured fallback.
 * The returned prefix is fitted against the real serialized Action boundary;
 * there is no provider-independent guessed byte reserve.
 */
async function readGitlabRawDiffUnbounded(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabRawDiffResultV1> {
  const parsed = GitlabRawDiffInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGitlabItemInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['merge-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const raw = await readGitlabRawDiffText(admitted.route, admitted.dependencies);
  if (!raw.ok) return unavailable(projectGitlabSourceFailure(raw.failure));

  return fitActionResultTextV1(raw.value, (text, truncated) => Object.freeze({
    kind: 'rawDiff' as const,
    text,
    truncated,
  }));
}

export const listGitlabNotes = listGitlabNotesUnbounded;
export const listGitlabActivityEvents = listGitlabActivityEventsUnbounded;
export const listGitlabDiscussions = listGitlabDiscussionsUnbounded;
export const readGitlabApprovals = readGitlabApprovalsUnbounded;
export const listGitlabPipelines = listGitlabPipelinesUnbounded;
export const listGitlabChanges = listGitlabChangesUnbounded;
export const readGitlabRawDiff = readGitlabRawDiffUnbounded;
