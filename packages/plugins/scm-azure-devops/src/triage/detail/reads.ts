import { createAzureDevOpsFailure } from '../failures.js';
import type {
  AzureDevOpsApiClient,
  AzureDevOpsFailure,
  AzureDevOpsRoute,
} from '../types.js';

import {
  AZURE_DETAIL_BOUNDS_V1,
  projectAzureCommitRows,
  projectAzureIterationChanges,
  projectAzureIterationRows,
  projectAzurePolicyEvaluationRows,
  projectAzureStatusRows,
  projectAzureThreadRows,
  type AzureChangesProjectionV1,
  type AzurePageProjectionV1,
  type AzureProjectedCommitRowV1,
  type AzureProjectedIterationRowV1,
  type AzureProjectedPolicyEvaluationRowV1,
  type AzureProjectedStatusRowV1,
  type AzureProjectedThreadRowV1,
} from './projection.js';

/**
 * The bounded reads behind the Azure DevOps detail planes.
 *
 * Two provider facts shape everything here, and neither is shared with the other
 * three forges:
 *
 * - **the iteration list is read ONCE, by the detail root.** Every push to the
 *   source branch produces an iteration, and `Activity` and `Files` both need to
 *   know which one is current. Two readers would answer from two different
 *   snapshots, so there is one read and one projection passed to both;
 * - **paging positions are provider-issued, never computed.** The commits
 *   collection hands back a continuation token in a response header; the
 *   iteration-changes collection hands back `nextSkip` and `nextTop` in the
 *   body. A self-incremented `$skip` is how a caller silently re-reads or skips
 *   files, so this source never computes one.
 */

export type AzureDetailReadResultV1<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

export type AzureDetailReadDependenciesV1 = Readonly<{
  client: AzureDevOpsApiClient;
  signal: AbortSignal;
}>;

export const AZURE_CONTINUATION_TOKEN_HEADER_V1 = 'x-ms-continuationtoken';

/** One page of pull-request commits. Azure's own default window for this tab. */
export const AZURE_COMMITS_PAGE_SIZE_V1 = 30;
/** One page of iteration changes. The provider decides every following window. */
export const AZURE_CHANGES_PAGE_SIZE_V1 = 100;
/** One bounded page of policy evaluations. */
export const AZURE_POLICY_EVALUATIONS_PAGE_SIZE_V1 = 100;

function malformed(detail: string): AzureDevOpsFailure {
  return createAzureDevOpsFailure({ failureClass: 'malformedResponse', detail });
}

async function requestJson(
  dependencies: AzureDetailReadDependenciesV1,
  route: AzureDevOpsRoute,
  query?: Readonly<Record<string, string | number | undefined>>,
): Promise<AzureDetailReadResultV1<Readonly<{
  body: unknown;
  headers: Readonly<Record<string, string>>;
}>>> {
  const response = await dependencies.client.request({
    route,
    ...(query === undefined ? {} : { query }),
    signal: dependencies.signal,
  });
  return response.ok
    ? { ok: true, value: { body: response.body, headers: response.headers } }
    : { ok: false, failure: response.failure };
}

/* ---------------------------------------------------------------- iterations */

export type AzureIterationsReadV1 = Readonly<{
  rows: readonly AzureProjectedIterationRowV1[];
  /**
   * The real 1-based iteration `Files` compares against, or `null` when Azure
   * returned none. `null` is not iteration `0`: `0` is the documented
   * `compareTo` baseline and is never a path id.
   */
  currentIterationId: number | null;
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

/**
 * The one shared iteration read.
 *
 * It exists exactly once per mounted detail body. `Activity` and `Files` consume
 * its projection rather than reading the list again, so the two tabs can never
 * disagree about which iteration is current.
 */
export async function readAzureIterations(
  input: Readonly<{ repositoryId: string; pullRequestId: number }>,
  dependencies: AzureDetailReadDependenciesV1,
): Promise<AzureDetailReadResultV1<AzureIterationsReadV1>> {
  const response = await requestJson(dependencies, {
    resource: 'iterations',
    repositoryId: input.repositoryId,
    pullRequestId: input.pullRequestId,
  });
  if (!response.ok) return response;

  const projected = projectAzureIterationRows(response.value.body, AZURE_DETAIL_BOUNDS_V1);
  // The current iteration is the highest real id Azure returned. A pull request
  // whose iteration list is empty has none, and saying so beats guessing `1`.
  const currentIterationId = projected.rows.reduce<number | null>(
    (highest, row) => (highest === null || row.id > highest ? row.id : highest),
    null,
  );
  return {
    ok: true,
    value: Object.freeze({
      rows: projected.rows,
      currentIterationId,
      omittedRowCount: projected.omittedRowCount,
      projectionTruncated: projected.projectionTruncated,
    }),
  };
}

/* ------------------------------------------------------------------- commits */

export type AzureCommitsReadV1 =
  AzurePageProjectionV1<AzureProjectedCommitRowV1> & Readonly<{
    /** Azure's own continuation token, from the response header, or `null`. */
    continuationToken: string | null;
  }>;

export async function readAzureCommitsPage(
  input: Readonly<{
    repositoryId: string;
    pullRequestId: number;
    continuationToken: string | null;
  }>,
  dependencies: AzureDetailReadDependenciesV1,
): Promise<AzureDetailReadResultV1<AzureCommitsReadV1>> {
  const response = await requestJson(
    dependencies,
    { resource: 'commits', repositoryId: input.repositoryId, pullRequestId: input.pullRequestId },
    {
      $top: AZURE_COMMITS_PAGE_SIZE_V1,
      ...(input.continuationToken === null
        ? {}
        : { continuationToken: input.continuationToken }),
    },
  );
  if (!response.ok) return response;

  const projected = projectAzureCommitRows(response.value.body, AZURE_DETAIL_BOUNDS_V1);
  const header = response.value.headers[AZURE_CONTINUATION_TOKEN_HEADER_V1];
  const continuationToken = typeof header === 'string' && header.trim() !== ''
    ? header.trim()
    : null;
  return { ok: true, value: Object.freeze({ ...projected, continuationToken }) };
}

/* --------------------------------------------------------- iteration changes */

/**
 * One page of one iteration's changed files.
 *
 * `$compareTo=0` is the documented comparison BASELINE — the state before the
 * first iteration — while `iterationId` is a real 1-based iteration in the path.
 * Passing `0` as the path id asks for a resource that does not exist.
 */
export async function readAzureIterationChangesPage(
  input: Readonly<{
    repositoryId: string;
    pullRequestId: number;
    iterationId: number;
    skip: number;
    top: number;
  }>,
  dependencies: AzureDetailReadDependenciesV1,
): Promise<AzureDetailReadResultV1<AzureChangesProjectionV1>> {
  if (!Number.isSafeInteger(input.iterationId) || input.iterationId < 1) {
    return { ok: false, failure: malformed('An Azure DevOps iteration id must be 1-based.') };
  }
  const response = await requestJson(
    dependencies,
    {
      resource: 'iterationChanges',
      repositoryId: input.repositoryId,
      pullRequestId: input.pullRequestId,
      iterationId: input.iterationId,
    },
    { $compareTo: 0, $skip: input.skip, $top: input.top },
  );
  if (!response.ok) return response;
  return {
    ok: true,
    value: projectAzureIterationChanges(response.value.body, AZURE_DETAIL_BOUNDS_V1),
  };
}

/* ------------------------------------------------------------------ policies */

export type AzurePoliciesReadV1 = Readonly<{
  statuses: readonly AzureProjectedStatusRowV1[];
  evaluations: readonly AzureProjectedPolicyEvaluationRowV1[];
  /**
   * True when the evaluation read failed after the statuses succeeded.
   *
   * Only the evaluation half is marked partial. The statuses are real and stay,
   * and a reader is told which half is short rather than losing both.
   */
  evaluationsPartial: boolean;
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

/**
 * The whole policy surface of one pull request.
 *
 * Statuses and policy evaluations are separate resources with separate scopes:
 * a status hangs off the Git pull request, while an evaluation is project-scoped
 * and selects the item through an `artifactId`. They are read together because
 * their rendered answer is one section, and because a status is INFORMATIONAL
 * until a returned evaluation's `configuration.isBlocking` establishes
 * enforcement.
 */
export async function readAzurePoliciesSurface(
  input: Readonly<{
    repositoryId: string;
    pullRequestId: number;
    project: string;
    projectId: string;
  }>,
  dependencies: AzureDetailReadDependenciesV1,
): Promise<AzureDetailReadResultV1<AzurePoliciesReadV1>> {
  const statuses = await requestJson(dependencies, {
    resource: 'statuses',
    repositoryId: input.repositoryId,
    pullRequestId: input.pullRequestId,
  });
  if (!statuses.ok) return statuses;
  const projectedStatuses = projectAzureStatusRows(statuses.value.body, AZURE_DETAIL_BOUNDS_V1);

  const evaluations = await requestJson(
    dependencies,
    { resource: 'policyEvaluations', project: input.project },
    {
      // The documented artifact identifier for a pull request's code review.
      artifactId:
        `vstfs:///CodeReview/CodeReviewId/${input.projectId}/${String(input.pullRequestId)}`,
      $top: AZURE_POLICY_EVALUATIONS_PAGE_SIZE_V1,
      $skip: 0,
    },
  );
  if (!evaluations.ok) {
    // The statuses are real evidence and are kept; only the evaluation half is
    // reported short. Failing both would hide policy state the reader can see.
    return {
      ok: true,
      value: Object.freeze({
        statuses: projectedStatuses.rows,
        evaluations: Object.freeze([]),
        evaluationsPartial: true,
        omittedRowCount: projectedStatuses.omittedRowCount,
        projectionTruncated: projectedStatuses.projectionTruncated,
      }),
    };
  }

  const projectedEvaluations = projectAzurePolicyEvaluationRows(
    evaluations.value.body,
    AZURE_DETAIL_BOUNDS_V1,
  );
  return {
    ok: true,
    value: Object.freeze({
      statuses: projectedStatuses.rows,
      evaluations: projectedEvaluations.rows,
      evaluationsPartial: false,
      omittedRowCount: projectedStatuses.omittedRowCount + projectedEvaluations.omittedRowCount,
      projectionTruncated:
        projectedStatuses.projectionTruncated || projectedEvaluations.projectionTruncated,
    }),
  };
}

/* ------------------------------------------------------------------- threads */

export type AzureThreadsReadV1 = AzurePageProjectionV1<AzureProjectedThreadRowV1>;

/**
 * Every review thread on one pull request, in one read.
 *
 * The documented list endpoint returns them all and exposes no `$top`, `$skip`,
 * continuation token or next link. Its only optional arguments are the iteration
 * lens, so the reader's 18-thread and 2-reply windows are client-local over this
 * one response — never an invented cursor.
 */
export async function readAzureThreads(
  input: Readonly<{
    repositoryId: string;
    pullRequestId: number;
    /** Both are supplied together or not at all: a lens is a comparison. */
    iterationLens: Readonly<{ iteration: number; baseIteration: number }> | null;
  }>,
  dependencies: AzureDetailReadDependenciesV1,
): Promise<AzureDetailReadResultV1<AzureThreadsReadV1>> {
  const response = await requestJson(
    dependencies,
    { resource: 'threads', repositoryId: input.repositoryId, pullRequestId: input.pullRequestId },
    input.iterationLens === null
      ? undefined
      : {
        // The literal `$` matters: dropping it is how every thread comes back
        // unfiltered while the caller believes the lens was applied.
        $iteration: input.iterationLens.iteration,
        $baseIteration: input.iterationLens.baseIteration,
      },
  );
  if (!response.ok) return response;
  return { ok: true, value: projectAzureThreadRows(response.value.body, AZURE_DETAIL_BOUNDS_V1) };
}
