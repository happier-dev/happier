import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
  TriageGetInputV1Schema,
  TriagePullRequestStatusResultV1Schema,
  type TriagePullRequestStatusResultV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import {
  fitActionResultPageV1,
  fitActionResultSequenceV1,
} from '@happier-dev/triage-sources/projection/actionResultSequence';

import { admitGithubDetailInvocation, admitGithubEntryInvocation } from './admission.js';
import {
  GithubCapabilitiesInputV1Schema,
  GithubChangedFilesInputV1Schema,
  GithubChecksInputV1Schema,
  GithubFeedbackInputV1Schema,
  GithubFeedbackResultV1Schema,
  GithubOverviewInputV1Schema,
  GithubTimelineInputV1Schema,
  type GithubChangedFilesResultV1,
  type GithubCapabilitiesResultV1,
  type GithubChecksResultV1,
  type GithubFeedbackResultV1,
  type GithubOverviewResultV1,
  type GithubTimelineResultV1,
} from './detail/contracts.js';
import { projectGithubRepositoryCapabilities } from './capabilities.js';
import {
  readGithubFeedbackConnection,
  type GithubFeedbackCommentV1,
} from './feedback.js';
import { readGithubRepositoryIdFromCollisionScope } from './identity.js';
import {
  decodeGithubDetailContinuation,
  encodeGithubDetailContinuation,
} from './detail/continuation.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubCheckRows,
  projectGithubDetailIdentifierV1,
} from './detail/projection.js';
import {
  readGithubChangedFilesPage,
  readGithubPullRequestComparisonEndpoints,
  readGithubPullRequestComparisonBeforeOid,
  readGithubChecksSurface,
  readGithubTimelinePage,
  type GithubDetailPageV1,
} from './detail/reads.js';
import { toTriageFailure, toTriageFacts } from './mapping/protocol.js';
import { mapGithubMergeability, readGithubIssue, readGithubPullRequest } from './get.js';
import { createGithubRepositoryReader } from './repositories.js';
import { readGithubPullRequestChecks } from './checks.js';
import { readGithubCheckOutcomeV1 } from './checkOutcome.js';
import { buildGithubStateRowFactsV1 } from './mapping/facts.js';
import { readLatestGithubReviewsV1 } from './mapping/reviews.js';
import { classifyGithubTransportFailure } from './errors.js';
import { buildGithubRepositoryKey } from './locator.js';

/**
 * The seven bound source-native detail operations.
 *
 * Each is the whole vertical for one Action invocation: it validates the
 * published input, admits the configured instance through the SAME rule `scan`
 * and `get` use, resolves the route from current source evidence, materializes
 * that exact account inside one request closure, and shapes the result into the
 * published contract. It owns no registry, no cache, no second route authority,
 * and it writes no configured state.
 *
 * The detail body invokes these; it never holds a credential, constructs a URL,
 * or sees a raw provider body. What crosses back is only what the boundary
 * projector copied.
 *
 * Every failure is a STATED outcome rather than an empty result. A timeline
 * refused for permission, a changed-file walk stopped at GitHub's documented
 * ceiling, and a pull request with no changed files at all are three different
 * answers, and each panel is given the one that is true.
 */

const INVALID_INPUT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_input_invalid',
});

const CONTINUATION_UNREADABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_continuation_unreadable',
});

/**
 * Resolves the page one paged detail read starts from.
 *
 * A continuation this source did not mint, or one minted under a different page
 * geometry, is refused rather than reinterpreted: resuming at a page number that
 * names different rows would silently skip or repeat part of the collection.
 */
function resolvePage(
  continuation: string | undefined,
  limit: number,
): Readonly<{ ok: true; page: number }> | Readonly<{ ok: false }> {
  if (continuation === undefined) return Object.freeze({ ok: true as const, page: 1 });
  const frontier = decodeGithubDetailContinuation(continuation);
  if (frontier === null || frontier.perPage !== limit) {
    return Object.freeze({ ok: false as const });
  }
  return Object.freeze({ ok: true as const, page: frontier.page });
}

function mintContinuation(nextPage: number | null, perPage: number): string | null {
  return nextPage === null
    ? null
    : encodeGithubDetailContinuation({ v: 1, page: nextPage, perPage });
}

type PagedShape<TRow> = Readonly<{
  rows: readonly TRow[];
  omittedRowCount: number;
  projectionTruncated: boolean;
  incomplete?: 'ceiling' | 'pagination';
  continuation?: string;
}>;

/** Shapes one settled page into the members every paged plane result shares. */
function shapePage<TRow>(
  page: GithubDetailPageV1<TRow>,
  perPage: number,
): PagedShape<TRow> {
  const continuation = mintContinuation(page.nextPage, perPage);
  // A next page this source cannot mint a token for ends the walk, and saying so
  // is the point: a silently dropped position reads as a finished collection.
  const incomplete = page.incomplete
    ?? (page.nextPage !== null && continuation === null ? 'pagination' : null);
  return Object.freeze({
    rows: page.rows,
    omittedRowCount: page.omittedRowCount,
    projectionTruncated: page.projectionTruncated,
    ...(incomplete === null ? {} : { incomplete }),
    ...(continuation === null ? {} : { continuation }),
  });
}

function unavailable(failure: TriageSourceFailureV1): Readonly<{
  kind: 'unavailable';
  failure: TriageSourceFailureV1;
}> {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

export async function readGithubCapabilities(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubCapabilitiesResultV1> {
  const parsed = GithubCapabilitiesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request', 'issue'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  return Object.freeze({
    kind: 'capabilities' as const,
    ...projectGithubRepositoryCapabilities(admitted.repository),
  });
}

/* -------------------------------------------------------------------- overview */

const ENTRY_ABSENT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_entry_absent',
});

const ENTRY_NOT_OBSERVED_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_entry_not_observed',
});

/** One explicit exact entity reread; the launched observation remains the initial view. */
export async function readGithubOverview(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubOverviewResultV1> {
  const parsed = GithubOverviewInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request', 'issue'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const dependencies = Object.freeze({
    client: admitted.client,
    now: Date.now,
    signal: admitted.signal,
    repositories: createGithubRepositoryReader({ client: admitted.client, now: Date.now }),
  });
  if (admitted.kindId === 'pull-request') {
    const read = await readGithubPullRequest(
      admitted.localRef,
      admitted.route,
      dependencies.repositories,
      dependencies,
    );
    if (read.observation.kind === 'unresolved') {
      return unavailable(toTriageFailure(read.observation.failure));
    }
    if (read.observation.kind === 'absent') return unavailable(ENTRY_ABSENT_FAILURE);
    if (read.observation.kind !== 'present' || read.overview === null) {
      return unavailable(ENTRY_NOT_OBSERVED_FAILURE);
    }
    return Object.freeze({
      kind: 'overview' as const,
      kindId: 'pull-request' as const,
      observedAtMs: Date.now(),
      ...read.overview,
    });
  }

  const read = await readGithubIssue(
    admitted.localRef,
    admitted.route,
    dependencies.repositories,
    dependencies,
  );
  if (read.observation.kind === 'unresolved') {
    return unavailable(toTriageFailure(read.observation.failure));
  }
  if (read.observation.kind === 'absent') return unavailable(ENTRY_ABSENT_FAILURE);
  if (read.observation.kind !== 'present' || read.overview === null) {
    return unavailable(ENTRY_NOT_OBSERVED_FAILURE);
  }
  return Object.freeze({
    kind: 'overview' as const,
    kindId: 'issue' as const,
    observedAtMs: Date.now(),
    ...read.overview,
  });
}

/* ------------------------------------------------------------------- timeline */

/** One bounded page of the event timeline of a pull request or an issue. */
export async function listGithubTimeline(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubTimelineResultV1> {
  const parsed = GithubTimelineInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const position = resolvePage(request.continuation, request.limit);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request', 'issue'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const page = await readGithubTimelinePage({
    route: admitted.route,
    entryNumber: admitted.entryNumber,
    perPage: request.limit,
    page: position.page,
  }, { client: admitted.client, now: Date.now });
  if (!page.ok) return unavailable(toTriageFailure(page.failure));

  return Object.freeze({
    kind: 'timeline' as const,
    ...shapePage(page.value, request.limit),
  });
}

/* -------------------------------------------------------------- changed files */

/** One bounded page of the changed files of a pull request. */
export async function listGithubChangedFiles(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubChangedFilesResultV1> {
  const parsed = GithubChangedFilesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const position = resolvePage(request.continuation, request.limit);
  if (!position.ok) return unavailable(CONTINUATION_UNREADABLE_FAILURE);

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    // An issue has no changed files, and answering with an empty page would be a
    // different claim from "this plane does not apply to this kind".
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const frontier = request.continuation === undefined ? null : decodeGithubDetailContinuation(request.continuation);
  if (request.comparison !== true && frontier?.comparison !== undefined) return unavailable(CONTINUATION_UNREADABLE_FAILURE);
  const dependencies = { client: admitted.client, now: Date.now };
  const endpointInput = { route: admitted.route, entryNumber: admitted.entryNumber, repositoryId: admitted.repository.repositoryId };
  const binding = JSON.stringify([request.instance.instance, request.instance.binding.account, admitted.localRef, admitted.route]);
  const previous = frontier?.comparison;
  if (request.comparison === true && request.continuation !== undefined && (previous === undefined || previous.binding !== binding)) return unavailable(CONTINUATION_UNREADABLE_FAILURE);
  const captured = request.comparison === true
    ? await readGithubPullRequestComparisonEndpoints(endpointInput, dependencies)
    : null;
  if (captured !== null && !captured.ok) return unavailable(toTriageFailure(captured.failure));
  // This route has passed Account/repository admission; the metadata read proves
  // its PR number and repository id. Caller display fields are never this fact.
  const repository = buildGithubRepositoryKey(admitted.route);
  const number = Number(admitted.entryNumber);
  if (request.comparison === true && (repository === null || !Number.isSafeInteger(number) || number < 1)) return unavailable(INVALID_INPUT_FAILURE);
  const locator = Object.freeze({ providerId: 'github' as const, repository: repository ?? '', number });
  if (captured?.ok && previous !== undefined && (previous.baseOid !== captured.value.baseOid || previous.headOid !== captured.value.headOid || previous.totalFileCount !== captured.value.totalFileCount)) {
    return Object.freeze({ kind: 'changedFiles', rows: Object.freeze([]), omittedRowCount: 0, projectionTruncated: false,
      comparison: Object.freeze({ ...captured.value, locator, beforeOid: previous.beforeOid, baseOid: previous.baseOid, headOid: previous.headOid, totalFileCount: previous.totalFileCount,
        enumeratedFileCount: previous.enumeratedFileCount, freshness: 'stale', inventory: 'incomplete', content: previous.contentIncomplete ? 'incomplete' : 'complete', reasons: Object.freeze(['source_changed']) }),
    });
  }

  const before = captured?.ok
    ? previous !== undefined ? { ok: true as const, value: previous.beforeOid }
      : await readGithubPullRequestComparisonBeforeOid({ route: admitted.route, ...captured.value }, dependencies)
    : null;
  if (before !== null && !before.ok) return unavailable(toTriageFailure(before.failure));
  const endpoints = captured?.ok && before?.ok ? { ...captured.value, beforeOid: before.value } : null;

  const page = await readGithubChangedFilesPage({
    route: admitted.route,
    entryNumber: admitted.entryNumber,
    perPage: request.limit,
    page: position.page,
    ...(request.comparison === true ? { comparison: true as const } : {}),
  }, dependencies);
  if (!page.ok) {
    if (endpoints) return Object.freeze({ kind: 'changedFiles', rows: Object.freeze([]), omittedRowCount: 0, projectionTruncated: false,
      comparison: Object.freeze({ ...endpoints, locator, enumeratedFileCount: previous?.enumeratedFileCount ?? 0,
        freshness: 'unverified', inventory: 'incomplete', content: 'incomplete', reasons: Object.freeze(['page_failed']), failure: toTriageFailure(page.failure) }),
    });
    return unavailable(toTriageFailure(page.failure));
  }

  if (endpoints) {
    const refreshed = await readGithubPullRequestComparisonEndpoints(endpointInput, dependencies);
    const freshness = !refreshed.ok ? 'unverified' as const
      : refreshed.value.baseOid !== endpoints.baseOid || refreshed.value.headOid !== endpoints.headOid || refreshed.value.totalFileCount !== endpoints.totalFileCount ? 'stale' as const : 'current' as const;
    const enumeratedFileCount = (previous?.enumeratedFileCount ?? 0) + page.value.rows.length + page.value.omittedRowCount;
    const reasons: string[] = [];
    if (page.value.nextPage !== null) reasons.push('pages_pending');
    if (page.value.incomplete !== null) reasons.push(page.value.incomplete);
    if (page.value.omittedRowCount > 0 || page.value.projectionTruncated || previous?.inventoryIncomplete) reasons.push('omitted_rows');
    if (page.value.nextPage === null && enumeratedFileCount !== endpoints.totalFileCount) reasons.push('file_count_mismatch');
    if (freshness !== 'current') reasons.push(freshness === 'stale' ? 'source_changed' : 'freshness_unverified');
    const inventory = reasons.length === 0 ? 'complete' as const : 'incomplete' as const;
    const contentIncomplete = previous?.contentIncomplete === true || page.value.rows.some((row) => row.evidence?.state !== 'available');
    const comparison = Object.freeze({ ...endpoints, locator, enumeratedFileCount, freshness, inventory,
      content: contentIncomplete ? 'incomplete' as const : 'complete' as const, reasons: Object.freeze(reasons),
      ...(!refreshed.ok ? { failure: toTriageFailure(refreshed.failure) } : {}),
    });
    const continuation = freshness === 'current' && page.value.nextPage !== null
      ? encodeGithubDetailContinuation({ v: 1, page: page.value.nextPage, perPage: request.limit, comparison: {
        binding, ...endpoints, enumeratedFileCount,
        inventoryIncomplete: page.value.omittedRowCount > 0 || page.value.projectionTruncated || previous?.inventoryIncomplete === true,
        contentIncomplete,
      } }) : null;
    const result = Object.freeze({ kind: 'changedFiles' as const, rows: page.value.rows, omittedRowCount: page.value.omittedRowCount,
      projectionTruncated: page.value.projectionTruncated, comparison,
      ...(page.value.incomplete === null ? {} : { incomplete: page.value.incomplete }),
      ...(continuation === null ? {} : { continuation }),
    });
    return fitGithubComparisonPage(result, request.limit);
  }

  return Object.freeze({
    kind: 'changedFiles' as const,
    ...shapePage(page.value, request.limit),
  });
}

/** Preserve inventory when exact text cannot cross the existing Action envelope. */
function fitGithubComparisonPage(
  result: Extract<GithubChangedFilesResultV1, { kind: 'changedFiles' }>,
  perPage: number,
): GithubChangedFilesResultV1 {
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(result)) return result;
  const comparison = result.comparison;
  if (comparison === undefined) return result;
  const rows = [...result.rows];
  const order = rows.map((row, index) => ({ index, size: row.evidence !== undefined && 'patch' in row.evidence ? row.evidence.patch.length : 0 }))
    .sort((a, b) => b.size - a.size);
  const frontier = result.continuation === undefined ? null : decodeGithubDetailContinuation(result.continuation);
  const continuation = frontier?.comparison === undefined ? null : encodeGithubDetailContinuation({ ...frontier,
    comparison: { ...frontier.comparison, contentIncomplete: true },
  });
  const shape = () => Object.freeze({ ...result, rows: Object.freeze([...rows]),
    comparison: Object.freeze({ ...comparison, content: 'incomplete' as const, reasons: Object.freeze([...comparison.reasons, 'transport_limit']) }),
    ...(continuation === null ? {} : { continuation }),
  });
  for (const item of order) {
    if (item.size === 0) continue;
    rows[item.index] = { ...rows[item.index]!, evidence: { state: 'unavailable', reason: 'transport_limit' } };
    const fitted = shape();
    if (isExternalActionResultWithinResponseEnvelopeLimitV1(fitted)) return fitted;
  }
  // Path/inventory bytes themselves can exceed the same transport contract. The
  // existing sequence fitter keeps a usable prefix and states omitted evidence.
  return fitActionResultSequenceV1(rows, (included, omitted) => ({ ...shape(), rows: included,
    omittedRowCount: result.omittedRowCount + omitted, projectionTruncated: true,
    comparison: { ...shape().comparison, inventory: 'incomplete' as const },
    ...(frontier?.comparison === undefined ? {} : { continuation: encodeGithubDetailContinuation({ ...frontier, perPage,
      comparison: { ...frontier.comparison, contentIncomplete: true, inventoryIncomplete: true },
    }) ?? undefined }),
  })).result;
}

/* ------------------------------------------------------------------- feedback */

/** Reads one independently paged feedback connection; issues expose comments only. */
export async function readGithubFeedback(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubFeedbackResultV1> {
  const parsed = GithubFeedbackInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: request.connection === 'comments'
      ? ['pull-request', 'issue']
      : ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  const repositoryId = readGithubRepositoryIdFromCollisionScope(admitted.localRef.collisionScope);
  if (repositoryId === null) return unavailable(INVALID_INPUT_FAILURE);

  const common = {
    route: admitted.route,
    repositoryId,
    number: admitted.entryNumber,
    cursor: request.cursor ?? null,
  };
  const connectionInput = admitted.kindId === 'issue'
    ? { ...common, kindId: 'issue' as const, connection: 'comments' as const }
    : request.connection === 'threadReplies'
      ? {
        ...common,
        kindId: 'pull-request' as const,
        connection: 'threadReplies' as const,
        threadId: request.threadId,
      }
      : {
        ...common,
        kindId: 'pull-request' as const,
        connection: request.connection,
      };
  const result = await readGithubFeedbackConnection(
    connectionInput,
    { client: admitted.client, now: Date.now, signal: admitted.signal },
  );

  if (result.kind === 'unavailable') return result;
  const shapeComment = (row: GithubFeedbackCommentV1) => ({
    id: row.id,
    body: row.body,
    ...(row.author !== null ? { author: row.author } : {}),
    ...(row.createdAtMs !== null ? { createdAtMs: row.createdAtMs } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.truncated === true ? { truncated: true as const } : {}),
  });
  if (result.kind === 'requests') {
    return GithubFeedbackResultV1Schema.parse(fitActionResultPageV1(
      result.rows,
      result.nextCursor ?? undefined,
      (rows, omittedRowCount, nextCursor, continuationOmitted) => Object.freeze({
        kind: 'requests' as const,
        rows: rows.map((row) => ({ ...row })),
        omittedRowCount,
        projectionTruncated: omittedRowCount > 0
          || rows.some((row) => row.truncated === true),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        ...(continuationOmitted ? { incomplete: 'continuationUnavailable' as const } : {}),
      }),
    ).result);
  }
  if (result.kind === 'reviews') {
    const projectedRows = result.rows.map((row) => ({
        id: row.id,
        body: row.body,
        state: row.state,
        ...(row.author === null ? {} : { author: row.author }),
        ...(row.submittedAtMs === null ? {} : { submittedAtMs: row.submittedAtMs }),
        ...(row.url === null ? {} : { url: row.url }),
        ...(row.truncated === true ? { truncated: true as const } : {}),
      }));
    return GithubFeedbackResultV1Schema.parse(fitActionResultPageV1(
      projectedRows,
      result.previousCursor ?? undefined,
      (rows, omittedRowCount, previousCursor, continuationOmitted) => Object.freeze({
        kind: 'reviews' as const,
        rows,
        ...(result.reviewDecision === null ? {} : { reviewDecision: result.reviewDecision }),
        omittedRowCount,
        projectionTruncated: omittedRowCount > 0
          || rows.some((row) => row.truncated === true),
        ...(previousCursor === undefined ? {} : { previousCursor }),
        ...(continuationOmitted ? { incomplete: 'continuationUnavailable' as const } : {}),
      }),
    ).result);
  }
  if (result.kind === 'threads') {
    const projectedRows = result.rows.map((row) => ({
        id: row.id,
        isResolved: row.isResolved,
        ...(row.firstReply === null ? {} : { firstReply: shapeComment(row.firstReply) }),
        replyCount: row.replyCount,
        replies: row.replies.map(shapeComment),
        ...(row.path === null ? {} : { path: row.path }),
        ...(row.line === null ? {} : { line: row.line }),
        ...(row.previousRepliesCursor === null ? {} : { previousRepliesCursor: row.previousRepliesCursor }),
        ...(row.truncated === true ? { truncated: true as const } : {}),
      }));
    return GithubFeedbackResultV1Schema.parse(fitActionResultPageV1(
      projectedRows,
      result.previousCursor ?? undefined,
      (rows, omittedRowCount, previousCursor, continuationOmitted) => Object.freeze({
        kind: 'threads' as const,
        rows,
        omittedRowCount,
        projectionTruncated: omittedRowCount > 0
          || rows.some((row) => row.truncated === true),
        ...(previousCursor === undefined ? {} : { previousCursor }),
        ...(continuationOmitted ? { incomplete: 'continuationUnavailable' as const } : {}),
      }),
    ).result);
  }
  const projectedRows = result.rows.map(shapeComment);
  return GithubFeedbackResultV1Schema.parse(fitActionResultPageV1(
    projectedRows,
    result.previousCursor ?? undefined,
    (rows, omittedRowCount, previousCursor, continuationOmitted) => Object.freeze({
      kind: result.kind,
      ...('threadId' in result ? { threadId: result.threadId } : {}),
      rows,
      omittedRowCount,
      projectionTruncated: omittedRowCount > 0
        || rows.some((row) => row.truncated === true),
      ...(previousCursor === undefined ? {} : { previousCursor }),
      ...(continuationOmitted ? { incomplete: 'continuationUnavailable' as const } : {}),
    }),
  ).result);
}

/* --------------------------------------------------------------------- checks */

/**
 * The whole check surface of one pull request, at its current head revision.
 *
 * The two provider collections are read together because their rollup is one
 * answer: one of them failing renders the other's rows beside a failure that
 * names which read could not be made, and neither is ever presented as "no
 * checks configured".
 */
export async function readGithubChecks(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubChecksResultV1> {
  const parsed = GithubChecksInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubDetailInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const read = await readGithubChecksSurface({
    route: admitted.route,
    entryNumber: admitted.entryNumber,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
  if (!read.ok) return unavailable(toTriageFailure(read.failure));

  const { headRevision, surface } = read.value;
  const projected = projectGithubCheckRows(surface.observations, GITHUB_DETAIL_BOUNDS_V1);
  return fitActionResultSequenceV1(projected.rows, (rows, omittedByEnvelope) => Object.freeze({
    kind: 'checks' as const,
    headRevision,
    state: surface.state,
    // The row-fact state this suite projects to, computed by `checks.ts` over
    // EVERY observation it read. Publishing it is what lets the detail surface
    // say what GitHub reports as wrong in the same words the list row uses,
    // without deriving a second answer from the bounded rows below.
    ...(surface.rowState === null ? {} : { rowState: surface.rowState }),
    rows,
    // A count is omitted rather than zeroed wherever a per-job breakdown is
    // unavailable: a rendered `0 failing` on a suite nobody could read is a
    // fabricated fact, not a conservative one.
    ...(surface.failingCount === null ? {} : { failingCount: surface.failingCount }),
    ...(surface.runningCount === null ? {} : { runningCount: surface.runningCount }),
    ...(surface.passingCount === null ? {} : { passingCount: surface.passingCount }),
    ...(surface.checkRunsFailure === null
      ? {}
      : { checkRunsFailure: toTriageFailure(surface.checkRunsFailure) }),
    ...(surface.commitStatusFailure === null
      ? {}
      : { commitStatusFailure: toTriageFailure(surface.commitStatusFailure) }),
    omittedRowCount: projected.omittedRowCount + omittedByEnvelope,
    projectionTruncated: projected.projectionTruncated || omittedByEnvelope > 0,
  })).result;
}

/* -------------------------------------------------------------------- reviews */

/** Detail-on-open summary; scan/get never fan out into these provider reads. */
export async function readGithubPullRequestStatus(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriagePullRequestStatusResultV1> {
  const parsed = TriageGetInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.lastKnownLocator?.routingToken ?? '',
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  const dependencies = { client: admitted.client, now: Date.now, signal: admitted.signal };
  const repositories = createGithubRepositoryReader(dependencies);
  const read = await readGithubPullRequest(admitted.localRef, admitted.route, repositories, dependencies);
  if (read.observation.kind === 'unresolved') return unavailable(toTriageFailure(read.observation.failure));
  if (read.observation.kind === 'absent') return unavailable(ENTRY_ABSENT_FAILURE);
  if (read.observation.kind !== 'present' || read.overview === null || read.facts === null) {
    return unavailable(ENTRY_NOT_OBSERVED_FAILURE);
  }
  const repositoryId = readGithubRepositoryIdFromCollisionScope(admitted.localRef.collisionScope);
  if (repositoryId === null) return unavailable(INVALID_INPUT_FAILURE);
  const feedbackInput = {
    route: admitted.route, repositoryId, number: admitted.entryNumber,
    kindId: 'pull-request' as const, cursor: null,
  };
  const [surface, reviews, requests] = await Promise.all([
    read.facts.headRevision === null ? null : readGithubPullRequestChecks({
      route: admitted.route, headSha: read.facts.headRevision,
    }, dependencies),
    readGithubFeedbackConnection({ ...feedbackInput, connection: 'reviews' }, dependencies),
    readGithubFeedbackConnection({ ...feedbackInput, connection: 'requests' }, dependencies),
  ]);
  if (admitted.signal.aborted) {
    return unavailable(toTriageFailure(classifyGithubTransportFailure(admitted.signal.reason)));
  }

  let projectionTruncated = false;
  const text = (value: string) => {
    const projected = projectTriageDisplayTextV1(value, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    projectionTruncated ||= projected.truncated;
    return projected.value;
  };
  type Status = Extract<TriagePullRequestStatusResultV1, { kind: 'status' }>;
  type CheckRow = NonNullable<Status['checks']>['rows'][number];
  type Reviewer = NonNullable<Status['review']>['reviewers'][number];
  const checkRows: CheckRow[] = [];
  for (const observation of surface?.observations ?? []) {
    const identifier = projectGithubDetailIdentifierV1(observation.key);
    const id = identifier?.value;
    projectionTruncated ||= identifier?.truncated === true;
    const name = text(observation.name);
    if (!id || !name) { projectionTruncated = true; continue; }
    const state = readGithubCheckOutcomeV1(observation);
    checkRows.push({ id, name, state,
      ...(observation.startedAtMs === null ? {} : { startedAtMs: observation.startedAtMs }),
      ...(observation.completedAtMs === null ? {} : { completedAtMs: observation.completedAtMs }),
    });
  }
  const reviewers = new Map<string, Reviewer>();
  let reviewIncomplete = reviews.kind !== 'reviews' || requests.kind !== 'requests';
  if (reviews.kind === 'reviews') {
    reviewIncomplete ||= reviews.previousCursor !== null || reviews.rows.some((row) => row.author === null);
    for (const [author, row] of readLatestGithubReviewsV1(reviews.rows)) {
      const verb: Reviewer['verb'] | null = row.state === 'APPROVED' ? 'approved'
        : row.state === 'CHANGES_REQUESTED' ? 'changesRequested'
        : row.state === 'COMMENTED' ? 'commented'
        : row.state === 'DISMISSED' ? 'dismissed' : row.state === 'PENDING' ? 'pending' : null;
      const name = text(author);
      if (verb === null || !name) { reviewIncomplete = true; continue; }
      reviewers.set(`user:${author}`, { name, verb });
    }
  }
  if (requests.kind === 'requests') {
    reviewIncomplete ||= requests.nextCursor !== null;
    for (const row of requests.rows) {
      const name = text(row.subject);
      if (!name) { reviewIncomplete = true; continue; }
      reviewers.set(`${row.kind}:${row.subject}`, { name, verb: 'pending' });
    }
  }
  const decision = reviews.kind === 'reviews' ? reviews.reviewDecision : null;
  const facts = toTriageFacts(buildGithubStateRowFactsV1({
    reviewDecision: decision, checks: surface?.rowState ?? null,
  }));
  const nativeMerge = mapGithubMergeability({ mergeable: read.facts.mergeable, mergeable_state: read.facts.mergeableState });
  const merge: Status['merge'] = {
    state: nativeMerge === 'computing' ? 'unknown'
      : nativeMerge ?? (read.facts.mergeable === true ? 'mergeable' : 'unknown'),
    blocker: nativeMerge === 'blocked' || nativeMerge === 'conflicts'
      ? text(read.facts.mergeableState ?? nativeMerge) || null : null,
  };
  const head = text(read.overview.headBranch ?? '');
  const base = text(read.overview.baseBranch ?? '');
  const branch: Status['branch'] = head && base ? { head, base,
    ...(read.overview.additions === undefined ? {} : { additions: read.overview.additions }),
    ...(read.overview.deletions === undefined ? {} : { deletions: read.overview.deletions }),
  } : null;
  const state = surface?.state === 'knownIncomplete' ? 'incomplete'
    : surface?.state === 'resolved' ? 'complete' : surface?.state ?? 'unknown';
  const checkIncomplete = state === 'incomplete' || state === 'unknown'
    || checkRows.length < (surface?.observations.length ?? 0);
  const reviewRows = [...reviewers.values()];
  const observedAtMs = Date.now();
  const rows = [
    ...checkRows.map((row) => ({ kind: 'check' as const, row })),
    ...reviewRows.map((row) => ({ kind: 'reviewer' as const, row })),
  ];
  const fitted = fitActionResultSequenceV1(rows, (included, omittedCount): Status => {
    const checks = included.flatMap((item) => item.kind === 'check' ? [item.row] : []);
    const includedReviewers = included.flatMap((item) => item.kind === 'reviewer' ? [item.row] : []);
    return {
      kind: 'status', observedAtMs,
      checks: { state, passed: surface?.passingCount ?? null, failed: surface?.failingCount ?? null,
        pending: surface?.runningCount ?? null,
        total: state === 'complete' || state === 'none' ? surface?.observations.length ?? null : null,
        rows: checks, incomplete: checkIncomplete || checks.length < checkRows.length,
      },
      review: { decision: decision === 'changes-requested' ? 'changesRequested'
        : decision === 'review-required' ? 'reviewRequired' : decision,
        reviewers: includedReviewers, incomplete: reviewIncomplete || includedReviewers.length < reviewRows.length,
      },
      merge, branch, facts: facts.facts,
      ...(projectionTruncated || facts.dropped || omittedCount > 0 ? { projectionTruncated: true } : {}),
    };
  });
  return TriagePullRequestStatusResultV1Schema.parse(fitted.result);
}
