import { tryReadGithubPositiveDecimal } from '../observations/githubProviderContracts.js';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { GithubTriageInvocationContext, GithubTriageObservationContext } from './invocation.js';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
  TriageSourceCredentialInputsV1,
  TriagePullRequestStatusResultV1Schema,
  type TriagePullRequestStatusResultV1,
  type TriagePullRequestStatusV1,
  type TriageSourceFailureV1,
  type TriageConfiguredSourceCredentialInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import {
  fitActionResultPageV1,
  fitActionResultSequenceV1,
} from '@happier-dev/triage-sources/projection/actionResultSequence';

import { admitGithubDetailInvocation, admitGithubEntryInvocation, type GithubAdmittedInvocationV1 } from './admission.js';
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
import type { GithubPullRequestOverviewV1 } from './detail/overview.js';
import { fitGithubPropertyChoices, githubPropertyChoicesEnvelopeFallback, readGithubPropertyChoices } from './detail/propertyChoices.js';
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
import { fitGithubChangedFilesPage } from './detail/fitChangedFiles.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubCheckRows,
  projectGithubDetailIdentifierV1,
  projectGithubDetailWebUrlV1,
} from './detail/projection.js';
import {
  readGithubChangedFilesPage,
  readGithubPullRequestComparisonEndpoints,
  readGithubPullRequestComparisonBeforeOid,
  readGithubTimelinePage,
  type GithubDetailPageV1,
} from './detail/reads.js';
import { toTriageFailure, toTriageFacts } from './mapping/protocol.js';
import { readGithubIssue, readGithubPullRequest, type GithubPullRequestReadV1 } from './get.js';
import { mapGithubMergeability } from './mapping/state.js';
import { createGithubRepositoryReader } from './repositories.js';
import { readGithubPullRequestChecks } from './checks.js';
import { readGithubCheckOutcomeV1 } from './checkOutcome.js';
import { buildGithubStateRowFactsV1 } from './mapping/facts.js';
import { readLatestGithubReviewsV1 } from './mapping/reviews.js';
import { classifyGithubTransportFailure, classifyGithubResponseFailure } from './errors.js';
import { buildGithubApiUrl, buildGithubRepositoryKey } from './locator.js';
import { decodeGithubJsonResponse } from '../observations/githubApiClient.js';
import { createGithubReadCadence } from '../observations/githubChannelPollCadence.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';
import { GITHUB_MAX_PAGE_SIZE_V1 } from './types.js';
import { resolveGithubTriageInstance } from './operations.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { buildGithubPullRequestOperationsV1 } from './pullRequestOperations.js';
import { projectGithubPullRequestFixResolution } from './pullRequestFixResolution.js';

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
  context: GithubTriageInvocationContext,
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
    ...projectGithubRepositoryCapabilities(admitted.repository, admitted.kindId),
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
  context: GithubTriageInvocationContext,
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
    const overview = read.overview;
    const propertyChoicesRead = request.includePropertyChoices === true
      ? readGithubPropertyChoices({ route: admitted.route,
        repositoryId: readGithubRepositoryIdFromCollisionScope(admitted.localRef.collisionScope) }, admitted.client)
      : undefined;
    const projectOverview = (status: TriagePullRequestStatusV1,
      capabilities?: Extract<GithubCapabilitiesResultV1, { kind: 'capabilities' }>,
      surface?: Awaited<ReturnType<typeof readGithubPullRequestChecks>> | null): Extract<GithubOverviewResultV1, { kind: 'overview'; kindId: 'pull-request' }> => {
      const checks = status.checks;
      const required = checks?.rows.filter((row) => row.required === true) ?? [];
      const superseded = status.branch?.headRevision !== undefined
        && read.facts?.headRevision !== status.branch.headRevision;
      const countsKnown = checks !== null && checks.state === 'complete' && !checks.incomplete
        && checks.rows.every((row) => typeof row.required === 'boolean');
      const requiredState: NonNullable<GithubPullRequestOverviewV1['requiredChecks']>['state'] = superseded ? 'superseded' : checks?.state === 'none' ? 'none' : !countsKnown ? 'unknown'
        : required.length === 0 ? 'none' : required.some((row) => row.state === 'unknown') ? 'unknown'
          : required.some((row) => row.state === 'failed') ? 'failed' : required.some((row) => row.state === 'pending') ? 'pending'
            : required.every((row) => row.state === 'passed') ? 'passed' : 'neutral';
      const decision = status.review?.decision;
      // The detail's one checks answer: the same rollup read this status came from, with
      // exactly the rows the fitted status carries, so the envelope measures them once.
      const statusHead = read.facts?.headRevision;
      const includedChecks = new Set(checks?.rows.map((row) => row.id));
      const checkObservations = surface?.observations.filter((observation) =>
        includedChecks.has(projectGithubDetailIdentifierV1(observation.key)?.value ?? '')) ?? [];
      const projectedChecks = surface === undefined || surface === null || statusHead === null || statusHead === undefined ? null
        : projectGithubCheckRows(checkObservations, GITHUB_DETAIL_BOUNDS_V1);
      const checksView = projectedChecks === null || surface === undefined || surface === null || !statusHead ? undefined
        : projectGithubChecksView(surface, statusHead, projectedChecks.rows,
          projectedChecks.omittedRowCount + surface.observations.length - checkObservations.length,
          projectedChecks.projectionTruncated || checkObservations.length < surface.observations.length);
      return Object.freeze({
        kind: 'overview' as const,
        kindId: 'pull-request' as const,
        observedAtMs: status.observedAtMs,
        ...overview,
        ...(propertyChoicesRead === undefined ? {} : { propertyChoices: githubPropertyChoicesEnvelopeFallback() }),
        ...(surface?.nativePullRequest?.viewerSubscription === undefined ? {}
          : { viewerSubscription: surface.nativePullRequest.viewerSubscription }),
        pullRequestStatus: status,
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(checksView === undefined ? {} : { checks: checksView }),
        requiredChecks: {
          state: requiredState,
          failingCount: countsKnown && required.length > 0 ? required.filter((row) => row.state === 'failed').length : null,
          pendingCount: countsKnown && required.length > 0 ? required.filter((row) => row.state === 'pending').length : null,
        },
        reviewDecision: decision === 'changesRequested' ? 'changes-requested'
          : decision === 'reviewRequired' ? 'review-required' : decision ?? null,
      });
    };
    // One fitting walk measures the real outer response, including its exact
    // Markdown. Its required subset still comes from provider-labelled rows.
    const [acquired, propertyChoices] = await Promise.all([
      readGithubPullRequestStatusEvidenceForAdmittedEntry(admitted, read, {
        instance: request.instance,
        includeBranchRules: request.includeBranchRules === true, includeCheckOutput: true, projectEnvelope: projectOverview,
      }),
      propertyChoicesRead,
    ]);
    if (acquired.status.kind === 'unavailable') return acquired.status;
    const result = projectOverview(acquired.status, acquired.capabilities, acquired.surface);
    return propertyChoices === undefined ? result : fitGithubPropertyChoices(result, propertyChoices);
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
  context: GithubTriageInvocationContext,
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
    repositoryId: admitted.repository.repositoryId,
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
  context: GithubTriageInvocationContext,
): Promise<GithubChangedFilesResultV1> {
  const parsed = GithubChangedFilesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  if (request.filePath !== undefined && request.comparison === true) return unavailable(INVALID_INPUT_FAILURE);
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
  const binding = JSON.stringify([request.instance.instance, request.instance.binding, admitted.localRef, admitted.route]);
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
    repositoryId: admitted.repository.repositoryId,
    entryNumber: admitted.entryNumber,
    perPage: request.limit,
    page: position.page,
    ...(request.comparison === true ? { comparison: true as const } : {}),
    ...(request.filePath === undefined ? {} : { filePath: request.filePath }),
  }, dependencies);
  if (!page.ok) {
    if (endpoints) return Object.freeze({ kind: 'changedFiles', rows: Object.freeze([]), omittedRowCount: 0, projectionTruncated: false,
      comparison: Object.freeze({ ...endpoints, locator, enumeratedFileCount: previous?.enumeratedFileCount ?? 0,
        freshness: 'unverified', inventory: 'incomplete', content: 'incomplete', reasons: Object.freeze(['page_failed']), failure: toTriageFailure(page.failure) }),
    });
    return unavailable(toTriageFailure(page.failure));
  }

  if (request.filePath !== undefined) {
    if (page.value.rows.length === 0) return unavailable({ class: 'transient', code: 'github_file_page_changed' });
    return fitGithubChangedFilesPage(Object.freeze({
      kind: 'changedFiles', rows: page.value.rows,
      omittedRowCount: page.value.omittedRowCount,
      projectionTruncated: page.value.projectionTruncated,
    }), request.limit);
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
    return fitGithubChangedFilesPage(result, request.limit);
  }

  return Object.freeze({
    kind: 'changedFiles' as const,
    ...shapePage(page.value, request.limit),
  });
}

/* ------------------------------------------------------------------- feedback */

/** Reads one independently paged feedback connection; issues expose comments only. */
export async function readGithubFeedback(
  input: unknown,
  context: GithubTriageInvocationContext,
): Promise<GithubFeedbackResultV1> {
  const parsed = GithubFeedbackInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
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
    ...(row.editable === true ? { editable: true as const } : {}),
    ...(row.suggestions ? { suggestions: row.suggestions } : {}),
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
        ...(row.commitRevision === undefined ? {} : { commitRevision: row.commitRevision }),
        ...(row.url === null ? {} : { url: row.url }),
        ...(row.truncated === true ? { truncated: true as const } : {}),
        ...(row.editable === true ? { editable: true as const } : {}),
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

/** A pull request whose head cannot be read has no commit to ask about; it is not one with no checks. */
const HEAD_REVISION_UNREADABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_head_revision_unreadable',
});

/**
 * The whole check surface of one pull request, at its current head revision.
 *
 * Agents, MCP and CLI read exactly the checks the UI states: this Action uses the
 * Overview's head-qualified GraphQL rollup (with per-check `isRequired` and output),
 * so there is one reader and one projector. Accepted tradeoff (P03-FORGE-GITHUB
 * batch 3): the rollup is slower at GitHub than the REST check-runs and status lists
 * (measured 1.67–1.76 s vs 0.80–1.02 s on one PR), and it carries only each check's
 * latest attempt, so earlier attempts are not listed, as in the UI. Do not add a
 * second reader for speed; the REST collection reader serves only the automation
 * event observer, which needs exact Check Run rows.
 */
export async function readGithubChecks(
  input: unknown,
  context: GithubTriageInvocationContext,
): Promise<GithubChecksResultV1> {
  const parsed = GithubChecksInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  // Check runs and statuses are keyed by commit, so the head is read now. The
  // canonical pull-request read is also this Action's one repository identity
  // proof: its body's numeric repository id must build this entry's collision
  // scope (a separate repository read only when the body omits it) before any
  // check collection is requested, exactly as for Overview and PR writes.
  const dependencies = { client: admitted.client, now: Date.now, signal: admitted.signal };
  const read = await readGithubPullRequest(admitted.localRef, admitted.route,
    createGithubRepositoryReader(dependencies), dependencies);
  if (read.observation.kind === 'unresolved') return unavailable(toTriageFailure(read.observation.failure));
  if (read.observation.kind === 'absent') return unavailable(ENTRY_ABSENT_FAILURE);
  if (read.observation.kind !== 'present' || read.facts === null) return unavailable(ENTRY_NOT_OBSERVED_FAILURE);
  const headRevision = read.facts.headRevision;
  if (headRevision === null) return unavailable(HEAD_REVISION_UNREADABLE_FAILURE);
  // The same head-qualified rollup read, with each check's output, that the Overview
  // states as the detail's checks: one reader and one projector for agents and the UI.
  const surface = await readGithubPullRequestChecks({ route: admitted.route, headSha: headRevision,
    repositoryId: readGithubRepositoryIdFromCollisionScope(admitted.localRef.collisionScope),
    includeOutput: true, observation: { pullRequestNumber: read.facts.number, selection: 'all' } }, dependencies);
  const projected = projectGithubCheckRows(surface.observations, GITHUB_DETAIL_BOUNDS_V1);
  return fitActionResultSequenceV1(projected.rows, (rows, omittedByEnvelope) => Object.freeze({
    kind: 'checks' as const,
    ...projectGithubChecksView(surface, headRevision, rows, projected.omittedRowCount + omittedByEnvelope,
      projected.projectionTruncated || omittedByEnvelope > 0),
  })).result;
}

/** The one checks view projection, for the Checks Action and the Overview's own rollup read. */
function projectGithubChecksView(
  surface: Awaited<ReturnType<typeof readGithubPullRequestChecks>>,
  headRevision: string,
  rows: ReturnType<typeof projectGithubCheckRows>['rows'],
  omittedRowCount: number,
  projectionTruncated: boolean,
) {
  return Object.freeze({
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
    omittedRowCount,
    projectionTruncated,
  });
}

/* -------------------------------------------------------------------- reviews */

/** The host binds this declared purpose to the Action's exact configured source.
 * Observation admits that lifetime only; it does not acquire provider status or credentials. */
export const observeGithubPullRequestStatus: PluginActionReadObserver<JsonValue, GithubTriageObservationContext> = (input, _invalidate, context) => {
  context.signal.throwIfAborted();
  const parsed = TriageSourceCredentialInputsV1.readPullRequestStatus.safeParse(input);
  if (!parsed.success || !resolveGithubTriageInstance(parsed.data.instance).ok || parsed.data.localRef.kindId !== 'pull-request') {
    throw new PluginError({ code: 'plugin_action_read_observation_unavailable', message: 'The configured PR source cannot be observed.' });
  }
  if (context.services.connectedAccounts.watch === undefined) {
    // The Account host privately owns this captured purpose's retirement.
    return { dispose() {} };
  }
  let cleanup: Promise<void> | undefined;
  const subscription = context.services.connectedAccounts.watch(GITHUB_CONNECTED_ACCOUNT_PURPOSE, () => {
    // Metadata resync is not a PR status change. The host retires this exact
    // purpose's observer lifetime privately when its credential authority changes.
  });
  const cleanupSubscription = async () => { await subscription.dispose(); };
  const dispose = (): Promise<void> => {
    context.signal.removeEventListener('abort', onAbort);
    return cleanup ??= cleanupSubscription();
  };
  const onAbort = () => { void dispose().catch(() => {}); };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  return { dispose };
};

/** Detail-on-open summary; scan/get never fan out into these provider reads. */
export async function readGithubPullRequestStatus(
  input: unknown,
  context: GithubTriageInvocationContext,
): Promise<TriagePullRequestStatusResultV1> {
  const parsed = TriageSourceCredentialInputsV1.get.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.lastKnownLocator?.routingToken ?? '',
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  const cadence = createGithubReadCadence(admitted.client, Date.now());
  return readGithubPullRequestStatusForAdmittedEntry({ ...admitted, client: cadence.client }, undefined, {
    instance: request.instance, readRefreshAfterMs: cadence.refreshAfterMs,
  });
}

type AdmittedStatusEntry = Pick<Extract<GithubAdmittedInvocationV1, { ok: true }>, 'route' | 'localRef' | 'client' | 'signal'>;

type StatusBranchRules = NonNullable<NonNullable<TriagePullRequestStatusV1['merge']>['branchRules']>;

/** Active applicable rules explain the base branch; they never label check rows. */
async function readGithubBranchRulesForStatus(admitted: AdmittedStatusEntry, repositoryId: string, baseBranch: string): Promise<Readonly<{
  value: StatusBranchRules;
  queueRequired: true | null;
  upToDateRequired: true | null;
  projectionTruncated: boolean;
}>> {
  const rows: Array<StatusBranchRules['rows'][number]> = [];
  let queueRequired: true | null = null;
  let upToDateRequired: true | null = null;
  let projectionTruncated = false;
  let incomplete = false;
  const result = (state: StatusBranchRules['state'], failure?: TriageSourceFailureV1) => ({
    value: { state, rows, ...(failure === undefined ? {} : { failure }) },
    queueRequired, upToDateRequired, projectionTruncated,
  });
  const record = (value: unknown): Readonly<Record<string, unknown>> | null => value !== null
    && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
  let url: string | null = `${buildGithubApiUrl(['repos', admitted.route.owner, admitted.route.name,
    'rules', 'branches', baseBranch])}?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`;
  while (url !== null) {
    admitted.signal.throwIfAborted();
    const requestedUrl: string = url;
    let response;
    try { response = await admitted.client.request({ url: requestedUrl }); }
    catch (error) {
      admitted.signal.throwIfAborted();
      return result(rows.length === 0 ? 'unknown' : 'incomplete', toTriageFailure(classifyGithubTransportFailure(error)));
    }
    admitted.signal.throwIfAborted();
    if (response.status !== 200) return result(rows.length === 0 ? 'unknown' : 'incomplete',
      toTriageFailure(classifyGithubResponseFailure(response, Date.now())));
    let body: unknown;
    try { body = decodeGithubJsonResponse(response); }
    catch (error) { return result(rows.length === 0 ? 'unknown' : 'incomplete', toTriageFailure(classifyGithubTransportFailure(error))); }
    if (!Array.isArray(body)) return result(rows.length === 0 ? 'unknown' : 'incomplete',
      { class: 'unsupportedContract', code: 'github_branch_rules_invalid' });
    for (const raw of body) {
      const rule = record(raw);
      if (!rule || typeof rule.type !== 'string') { incomplete = true; continue; }
      const type = projectTriageDisplayTextV1(rule.type, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
      if (!type.value || type.truncated) { projectionTruncated = true; incomplete = true; continue; }
      const nativeRulesetId = typeof rule.ruleset_id === 'string' && rule.ruleset_id !== rule.ruleset_id.trim()
        ? null : tryReadGithubPositiveDecimal(rule.ruleset_id);
      const rulesetId = nativeRulesetId === null ? null : projectGithubDetailIdentifierV1(nativeRulesetId);
      if (rulesetId?.truncated) { projectionTruncated = true; incomplete = true; }
      const sourceUrl = projectGithubDetailWebUrlV1(record(record(rule._links)?.html)?.href);
      const parameters = record(rule.parameters);
      rows.push({ type: type.value,
        ...(rulesetId === null || rulesetId.truncated ? {} : { rulesetId: rulesetId.value }),
        ...(sourceUrl === null ? {} : { sourceUrl }),
        ...(rule.type === 'pull_request' ? { reviewThreadResolutionRequired:
          typeof parameters?.required_review_thread_resolution === 'boolean' ? parameters.required_review_thread_resolution : null,
        } : {}),
      });
      if (rule.type === 'merge_queue') queueRequired = true;
      // GitHub documents strictness as effective only with configured checks.
      if (rule.type === 'required_status_checks' && parameters?.strict_required_status_checks_policy === true
        && Array.isArray(parameters.required_status_checks) && parameters.required_status_checks.length > 0) upToDateRequired = true;
    }
    const next = readValidatedGithubFollowUpPage(response.headers, requestedUrl, repositoryId);
    if (next.kind === 'invalid') return result('incomplete', { class: 'unsupportedContract', code: 'github_branch_rules_link_invalid' });
    url = next.kind === 'next' ? next.url : null;
  }
  // Rulesets do not establish traditional branch protection or viewer exemptions.
  return result(incomplete ? 'incomplete' : 'complete');
}

type GithubPullRequestStatusReadOptionsV1 = Readonly<{ instance?: TriageConfiguredSourceCredentialInstanceV1;
  includeBranchRules?: boolean;
  /** The Overview's checks view needs each check's own output; status-only reads do not. */
  includeCheckOutput?: boolean;
  readRefreshAfterMs?: () => number | undefined;
  projectEnvelope?: (status: TriagePullRequestStatusV1, capabilities?: Extract<GithubCapabilitiesResultV1, { kind: 'capabilities' }>,
    surface?: Awaited<ReturnType<typeof readGithubPullRequestChecks>> | null) => unknown }>;

/** Public status and fresh writes consume the same acquisition as Overview. */
export async function readGithubPullRequestStatusForAdmittedEntry(
  admitted: AdmittedStatusEntry,
  freshRead?: GithubPullRequestReadV1,
  options: GithubPullRequestStatusReadOptionsV1 = {},
): Promise<TriagePullRequestStatusResultV1> {
  return (await readGithubPullRequestStatusEvidenceForAdmittedEntry(admitted, freshRead, options)).status;
}

/** One assembler; repository facts never travel through the generic status wire contract. */
async function readGithubPullRequestStatusEvidenceForAdmittedEntry(
  admitted: AdmittedStatusEntry,
  freshRead: GithubPullRequestReadV1 | undefined,
  options: GithubPullRequestStatusReadOptionsV1,
): Promise<Readonly<{ status: TriagePullRequestStatusResultV1;
  surface?: Awaited<ReturnType<typeof readGithubPullRequestChecks>> | null;
  capabilities?: Extract<GithubCapabilitiesResultV1, { kind: 'capabilities' }> }>> {
  const dependencies = { client: admitted.client, now: Date.now, signal: admitted.signal };
  const read = freshRead ?? await readGithubPullRequest(admitted.localRef, admitted.route,
    createGithubRepositoryReader(dependencies), dependencies);
  if (read.observation.kind === 'unresolved') return { status: unavailable(toTriageFailure(read.observation.failure)) };
  if (read.observation.kind === 'absent') return { status: unavailable(ENTRY_ABSENT_FAILURE) };
  if (read.observation.kind !== 'present' || read.overview === null || read.facts === null) {
    return { status: unavailable(ENTRY_NOT_OBSERVED_FAILURE) };
  }
  const repositoryId = readGithubRepositoryIdFromCollisionScope(admitted.localRef.collisionScope);
  if (repositoryId === null) return { status: unavailable(INVALID_INPUT_FAILURE) };
  let surface: Awaited<ReturnType<typeof readGithubPullRequestChecks>> | null;
  let requirementsFailure: TriageSourceFailureV1 | null = null;
  try {
    surface = read.facts.headRevision === null ? null : await readGithubPullRequestChecks({
      route: admitted.route, headSha: read.facts.headRevision, repositoryId,
      includeStatus: true, includeOutput: options.includeCheckOutput === true,
      observation: { pullRequestNumber: read.facts.number, selection: 'all' },
    }, dependencies);
  } catch (error) {
    const failure = toTriageFailure(classifyGithubTransportFailure(error));
    if (admitted.signal.aborted || failure.class === 'authentication') return { status: unavailable(failure) };
    // Requirements may be unreadable after exact PR admission. Preserve the
    // already-observed REST block/draft/conflict instead of erasing it.
    surface = null;
    requirementsFailure = failure;
  }
  if (admitted.signal.aborted) {
    return { status: unavailable(toTriageFailure(classifyGithubTransportFailure(admitted.signal.reason))) };
  }
  if (surface?.checkRunsFailure?.class === 'authentication') return { status: unavailable(toTriageFailure(surface.checkRunsFailure)) };
  requirementsFailure ??= surface?.checkRunsFailure ? toTriageFailure(surface.checkRunsFailure) : null;

  let projectionTruncated = false;
  const text = (value: string) => {
    const projected = projectTriageDisplayTextV1(value, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    projectionTruncated ||= projected.truncated;
    return projected.value;
  };
  const title = read.overview.title === undefined ? undefined : text(read.overview.title) || undefined;
  const sourceUrl = projectGithubDetailWebUrlV1(read.overview.webUrl);
  type Status = Extract<TriagePullRequestStatusResultV1, { kind: 'status' }>;
  type CheckRow = NonNullable<Status['checks']>['rows'][number];
  type Reviewer = NonNullable<Status['review']>['reviewers'][number];
  const checkRows: CheckRow[] = [];
  for (const observation of surface?.observations ?? []) {
    const identifier = projectGithubDetailIdentifierV1(observation.key);
    const id = identifier?.value;
    projectionTruncated ||= identifier?.truncated === true;
    const name = text(observation.name);
    if (!id || !name || identifier?.truncated) { projectionTruncated = true; continue; }
    const state = readGithubCheckOutcomeV1(observation);
    const detailsUrl = projectGithubDetailWebUrlV1(observation.detailsUrl);
    checkRows.push({ id, name, state, required: observation.required ?? null,
      ...(detailsUrl === null ? {} : { detailsUrl }),
      ...(observation.startedAtMs === null ? {} : { startedAtMs: observation.startedAtMs }),
      ...(observation.completedAtMs === null ? {} : { completedAtMs: observation.completedAtMs }),
    });
  }
  const reviewers = new Map<string, Reviewer>();
  const native = surface?.nativePullRequest;
  const fixSnapshot = projectGithubPullRequestFixResolution({ headRevision: read.facts.headRevision ?? '',
    draft: read.facts.draft, mergeable: read.facts.mergeable, mergeableState: read.facts.mergeableState, surface });
  let reviewIncomplete = native?.reviewIncomplete ?? true;
  if (native) {
    for (const [author, row] of readLatestGithubReviewsV1(native.reviews)) {
      const verb: Reviewer['verb'] | null = row.state === 'APPROVED' ? 'approved'
        : row.state === 'CHANGES_REQUESTED' ? 'changesRequested'
        : row.state === 'COMMENTED' ? 'commented'
        : row.state === 'DISMISSED' ? 'dismissed' : row.state === 'PENDING' ? 'pending' : null;
      const name = text(author);
      if (verb === null || !name) { reviewIncomplete = true; continue; }
      const id = projectGithubDetailIdentifierV1(`user:${author}`);
      if (id === null || id.truncated) { projectionTruncated = true; reviewIncomplete = true; continue; }
      reviewers.set(id.value, { id: id.value, name, verb });
    }
    for (const row of native.requests) {
      const name = text(row.subject);
      if (!name) { reviewIncomplete = true; continue; }
      const id = projectGithubDetailIdentifierV1(`${row.kind}:${row.subject}`);
      if (id === null || id.truncated) { projectionTruncated = true; reviewIncomplete = true; continue; }
      reviewers.set(id.value, { id: id.value, name, verb: 'pending' });
    }
  }
  const decision = surface?.reviewDecision ?? null;
  const facts = toTriageFacts(buildGithubStateRowFactsV1({
    reviewDecision: decision, checks: surface?.rowState ?? null,
  }));
  const nativeState = native?.mergeStateStatus === null || native?.mergeStateStatus === undefined ? null : text(native.mergeStateStatus) || null;
  const nativeMerge = mapGithubMergeability({ draft: read.facts.draft,
    mergeable: read.facts.mergeable, mergeable_state: read.facts.mergeableState });
  const structuralDraft = read.facts.draft || nativeState === 'DRAFT';
  const conflicts = fixSnapshot.conflicts === true;
  const stateAllowed = nativeState === 'CLEAN' || nativeState === 'HAS_HOOKS' || nativeState === 'UNSTABLE';
  const restBlocked = nativeMerge === 'blocked' && !stateAllowed;
  const superseded = surface?.observation?.state === 'superseded';
  const requiredCheckBlocker = surface?.observations.some((row) => {
    if (row.required !== true) return false;
    const outcome = readGithubCheckOutcomeV1(row);
    return outcome === 'pending' || outcome === 'failed';
  }) ?? false;
  const reviewBlocker = decision === 'review-required' || decision === 'changes-requested';
  const knownBlocker = requiredCheckBlocker || reviewBlocker;
  let rules: Awaited<ReturnType<typeof readGithubBranchRulesForStatus>> | null = null;
  if (read.overview.baseBranch && surface?.observation?.state !== 'superseded'
    && (options.includeBranchRules === true || (!knownBlocker && !structuralDraft && !conflicts
      && (stateAllowed || nativeState === 'BLOCKED' || nativeState === 'BEHIND' || restBlocked)))) {
    try {
      rules = await readGithubBranchRulesForStatus(admitted, repositoryId, read.overview.baseBranch);
      if (rules.value.failure?.class === 'authentication') return { status: unavailable(rules.value.failure) };
    } catch (error) {
      const failure = toTriageFailure(classifyGithubTransportFailure(error));
      if (admitted.signal.aborted || failure.class === 'authentication') return { status: unavailable(failure) };
      rules = { value: { state: 'unknown', rows: [], failure }, queueRequired: null, upToDateRequired: null, projectionTruncated: false };
    }
  }
  const queueId = native?.queue ? projectGithubDetailIdentifierV1(native.queue.id) : null;
  const nodeId = projectGithubDetailIdentifierV1(read.facts.nodeId ?? native?.nodeId ?? '');
  projectionTruncated ||= queueId?.truncated === true || nodeId?.truncated === true || rules?.projectionTruncated === true;
  const strictBehind = nativeState === 'BEHIND' && rules?.upToDateRequired === true;
  const blocked = nativeState === 'BLOCKED' || restBlocked
    || knownBlocker || strictBehind || rules?.queueRequired === true;
  const merge: Status['merge'] = {
    state: superseded ? 'unknown' : structuralDraft ? 'blocked' : conflicts ? 'conflicts' : blocked ? 'blocked'
      : stateAllowed && surface?.state !== 'unknown' && surface?.state !== 'knownIncomplete' ? 'mergeable' : 'unknown',
    blocker: superseded ? null : structuralDraft ? 'Draft pull request' : conflicts ? 'Merge conflicts'
      : requiredCheckBlocker ? 'Required checks have not passed' : reviewBlocker
        ? decision === 'changes-requested' ? 'Changes requested' : 'Review required'
        : strictBehind ? 'Branch must be up to date' : rules?.queueRequired === true ? 'Merge queue required'
          : blocked ? 'Blocked on GitHub' : null,
    draft: superseded ? null : read.facts.draft, nativeState,
    conflicts: fixSnapshot.conflicts,
    nodeId: nodeId === null || nodeId.truncated ? null : nodeId.value,
    canMergeWithoutWaiting: native?.canMergeWithoutWaiting ?? null,
    viewerCanUpdate: native?.viewerCanUpdate ?? null,
    viewerCanEnableAutoMerge: native?.viewerCanEnableAutoMerge ?? null,
    viewerCanDisableAutoMerge: native?.viewerCanDisableAutoMerge ?? null,
    queueRequired: rules?.queueRequired ?? null,
    upToDateRequired: rules?.upToDateRequired ?? null,
    ...(native?.queue === null ? { queue: null } : queueId && !queueId.truncated && native?.queue
      ? { queue: { ...native.queue, id: queueId.value, state: native.queue.state === null ? null : text(native.queue.state) || null } } : {}),
    autoMerge: superseded ? null : read.facts.autoMerge ?? null,
    ...(rules === null ? {} : { branchRules: rules.value }),
  };
  const head = text(read.overview.headBranch ?? '');
  const base = text(read.overview.baseBranch ?? '');
  const observedHead = projectGithubDetailIdentifierV1(surface?.observation?.currentHeadSha ?? read.facts.headRevision ?? '');
  projectionTruncated ||= observedHead?.truncated === true;
  const branch: Status['branch'] = head || base || observedHead !== null && !observedHead.truncated ? {
    ...(head ? { head } : {}),
    ...(base ? { base } : {}),
    ...(observedHead === null || observedHead.truncated ? {} : { headRevision: observedHead.value }),
    ...(read.overview.additions === undefined ? {} : { additions: read.overview.additions }),
    ...(read.overview.deletions === undefined ? {} : { deletions: read.overview.deletions }),
  } : null;
  const state = surface?.state === 'knownIncomplete' ? 'incomplete'
    : surface?.state === 'resolved' ? 'complete' : surface?.state ?? 'unknown';
  const checkIncomplete = state === 'incomplete' || state === 'unknown'
    || checkRows.length < (surface?.observations.length ?? 0);
  const reviewRows = [...reviewers.values()];
  const threadRows = fixSnapshot.threads.rows;
  const observedAtMs = Date.now();
  const entryState = read.observation.snapshot.state;
  const refreshAfterMs = entryState.presentation === 'active' ? options.readRefreshAfterMs?.() : undefined;
  const overview = read.overview;
  const headRevision = read.facts.headRevision ?? undefined;
  const repositoryKey = buildGithubRepositoryKey(admitted.route);
  const capabilities = projectGithubRepositoryCapabilities({
    kind: 'readable', repositoryId, repositoryKey,
    hasIssues: native?.repository.hasIssues ?? null, archived: native?.repository.archived ?? null,
    mergeSettings: native?.repository.mergeSettings ?? { merge: null, squash: null, rebase: null },
  }, 'pull-request');
  // These GraphQL fields are non-null booleans. An omitted/denied field cannot
  // prove parity with the repository read; its existing reader remains needed.
  const repository = native?.repository;
  const sharedCapabilities = repository !== undefined && typeof repository.hasIssues === 'boolean'
    && typeof repository.archived === 'boolean'
    && Object.values(repository.mergeSettings).every(value => typeof value === 'boolean')
    ? { kind: 'capabilities' as const, ...capabilities } : undefined;
  const rows = [
    ...checkRows.map((row) => ({ kind: 'check' as const, row })),
    ...reviewRows.map((row) => ({ kind: 'reviewer' as const, row })),
    ...threadRows.map((row) => ({ kind: 'thread' as const, row })),
    ...(rules?.value.rows.map((row) => ({ kind: 'branchRule' as const, row })) ?? []),
  ];
  const fitted = fitActionResultSequenceV1(rows, (included, omittedCount): Status => {
    const checks = included.flatMap((item) => item.kind === 'check' ? [item.row] : []);
    const includedReviewers = included.flatMap((item) => item.kind === 'reviewer' ? [item.row] : []);
    const threads = included.flatMap((item) => item.kind === 'thread' ? [item.row] : []);
    const status: Status = {
      kind: 'status', observedAtMs,
      ...(refreshAfterMs === undefined ? {} : { refreshAfterMs }),
      ...(title === undefined ? {} : { title }),
      ...(sourceUrl === null ? {} : { sourceUrl }),
      checks: { state, passed: surface?.passingCount ?? null, failed: surface?.failingCount ?? null,
        pending: surface?.runningCount ?? null,
        total: state === 'complete' || state === 'none' ? surface?.observations.length ?? null : null,
        rows: checks, incomplete: checkIncomplete || checks.length < checkRows.length,
        ...(requirementsFailure === null ? {} : { failure: requirementsFailure }),
      },
      review: { decision: decision === 'changes-requested' ? 'changesRequested'
        : decision === 'review-required' ? 'reviewRequired' : decision,
        reviewers: includedReviewers, incomplete: reviewIncomplete || includedReviewers.length < reviewRows.length,
        threads: { rows: threads,
          incomplete: fixSnapshot.threads.incomplete || requirementsFailure !== null || threads.length < threadRows.length,
          ...(requirementsFailure === null ? {} : { failure: requirementsFailure }),
        },
      },
      merge: rules === null ? merge : { ...merge, branchRules: { ...rules.value,
        rows: included.flatMap((item) => item.kind === 'branchRule' ? [item.row] : []),
        state: included.filter((item) => item.kind === 'branchRule').length < rules.value.rows.length ? 'incomplete' : rules.value.state,
      } }, branch, facts: facts.facts,
      ...(projectionTruncated || facts.dropped || omittedCount > 0 ? { projectionTruncated: true } : {}),
    };
    // Offers are sized with the same returned candidate. An omitted requirement
    // makes its acknowledgement incomplete before any bypass variant is emitted.
    if (options.instance !== undefined && !superseded && repositoryKey !== null) {
      const operations = buildGithubPullRequestOperationsV1({
        target: { instance: options.instance, localRef: admitted.localRef,
          routingToken: repositoryKey },
        state: entryState, headRevision, overview: { kindId: 'pull-request', ...overview }, capabilities, status,
      });
      if (operations !== undefined) return { ...status, operations };
    }
    return status;
  }, options.projectEnvelope === undefined ? undefined : status => options.projectEnvelope!(status, sharedCapabilities, surface));
  return { status: TriagePullRequestStatusResultV1Schema.parse(fitted.result), surface,
    ...(sharedCapabilities === undefined ? {} : { capabilities: sharedCapabilities }) };
}
