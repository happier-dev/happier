import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { resolveAzureConfiguredOrigin } from './configuration.js';
import {
  AzureCommitsInputV1Schema,
  AzureIterationChangesInputV1Schema,
  AzureIterationsInputV1Schema,
  AzurePoliciesInputV1Schema,
  AzureThreadsInputV1Schema,
  type AzureCommitsResultV1,
  type AzureIterationChangesResultV1,
  type AzureIterationsResultV1,
  type AzurePoliciesResultV1,
  type AzureThreadsResultV1,
} from './detail/contracts.js';
import {
  AZURE_CHANGES_PAGE_SIZE_V1,
  readAzureCommitsPage,
  readAzureIterationChangesPage,
  readAzureIterations,
  readAzurePoliciesSurface,
  readAzureThreads,
  type AzureDetailReadDependenciesV1,
} from './detail/reads.js';
import { createAzureSourceFailure, projectAzureSourceFailure } from './failureProjection.js';
import { parseAzureEntryLocalRef, type AzureEntryAddress } from './localRef.js';
import { authorizeClient, readPullRequestScope } from './operations.js';
import type {
  AzureDevOpsApiClient,
  AzureDevOpsHttpRequest,
  AzureDevOpsHttpResponse,
} from './types.js';

/**
 * The five bound source-native Azure DevOps detail operations.
 *
 * Each is the whole vertical for one Action invocation: it validates the
 * published input, resolves the configured origin through the SAME rule `scan`
 * and `get` use, proves the local ref against that base, reauthorizes that exact
 * account inside one request closure, and shapes the result into the published
 * contract. It owns no registry, no cache, and no second route authority, and it
 * writes no configured state.
 *
 * `readIterations` is deliberately its own operation rather than a step inside
 * `Files` and `Activity`. The detail root invokes it once and hands the same
 * projection to both tabs, so the two can never disagree about which iteration
 * is current — which is exactly what two independent iteration readers would
 * eventually do.
 */

/** The Action ids the mounted detail body invokes, and nothing else does. */
export const AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS = Object.freeze({
  readIterations: 'triage-read-iterations',
  listCommits: 'triage-list-commits',
  listIterationChanges: 'triage-list-iteration-changes',
  readPolicies: 'triage-read-policies',
  readThreads: 'triage-read-threads',
});

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * How long one mounted detail read may take before this source stops waiting.
 *
 * The resource it protects is a panel a person is looking at. Azure accepts a
 * request and then, on a stalled connection, neither answers nor fails, so
 * without a bound of our own the tab shows its loading state until the mount is
 * torn down — an outcome the reader cannot retry, cannot report, and cannot
 * distinguish from a very slow provider. `CONTRACT.md` §5.2 puts that bound on
 * the source: Triage owns deadlines only for the `listInstances`, `scan` and
 * `get` invocations it starts, and it neither supplies nor decides this one.
 *
 * It bounds the whole invocation rather than each request, because that is what
 * the reader experiences: `readPolicies` makes several calls behind one panel,
 * and three separately-bounded calls would let the panel wait three times as
 * long as the number here.
 */
export const AZURE_DEVOPS_MOUNTED_DETAIL_DEADLINE_MS = 20_000;

/**
 * The caller's signal, additionally bounded by this source's own deadline.
 *
 * The deadline aborts with a `TimeoutError` so the failure owner can tell it
 * apart from a caller cancellation (`failures.ts`); `AbortSignal.any` carries
 * whichever reason fired first through to every provider boundary below.
 *
 * The timer is dropped as soon as the caller's own signal aborts — the common
 * exit, since a detail read is cancelled with its mount — and is unreferenced so
 * a read nobody is waiting for cannot hold the daemon open.
 */
function boundDetailRead(callerSignal: AbortSignal, deadlineMs: number): AbortSignal {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException(
      'Azure DevOps did not answer this detail read within its deadline.',
      'TimeoutError',
    ));
  }, deadlineMs);
  (timer as unknown as Readonly<{ unref?: () => void }>).unref?.();
  callerSignal.addEventListener('abort', () => { clearTimeout(timer); }, { once: true });
  return AbortSignal.any([callerSignal, deadline.signal]);
}

/**
 * Adapt the host HTTP service to this source's one transport seam.
 *
 * `redirect: 'error'` is deliberate: Azure answers an unusable credential with a
 * redirect to a sign-in host, and a followed redirect would deliver that page's
 * HTML as if it were an API response.
 */
function toTransport(http: HttpService, signal: AbortSignal) {
  return async (request: AzureDevOpsHttpRequest): Promise<AzureDevOpsHttpResponse> => {
    const response = await http.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: new TextEncoder().encode(request.body) }),
      redirect: 'error',
    }, { signal });
    return {
      status: response.status,
      headers: response.headers,
      bodyText: TEXT_DECODER.decode(response.body),
    };
  };
}

function invalidInput(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/detail-input-invalid',
    detail: 'This Azure DevOps detail input is not the published V1 shape.',
  });
}

function undecodableConfiguration(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/configuration-undecodable',
    detail: 'This Azure DevOps configured-instance token was not produced by this source.',
  });
}

function entryOutsideInstance(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/entry-outside-configured-instance',
    detail: 'This entry reference was not derived from this configured Azure DevOps base.',
  });
}

function malformedPullRequest(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/malformed-pull-request',
    detail: 'Azure DevOps returned a pull request this source could not route or map.',
  });
}

function unavailable(failure: TriageSourceFailureV1): Readonly<{
  kind: 'unavailable';
  failure: TriageSourceFailureV1;
}> {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

type AdmittedInvocation =
  | Readonly<{
    ok: true;
    address: AzureEntryAddress;
    client: AzureDevOpsApiClient;
    dependencies: AzureDetailReadDependenciesV1;
  }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/**
 * Admits one detail invocation against the exact configured base.
 *
 * The scope is rebuilt from the configured base plus the ref's own repository
 * GUID and compared byte-for-byte, so a ref minted against a different
 * deployment cannot route through this instance. The account is rematerialized
 * on every invocation and grants no standing authority.
 */
async function admitAzureDetailInvocation(
  request: Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    localRef: TriageSourceEntryLocalRefV1;
  }>,
  context: PluginInvocationContext,
): Promise<AdmittedInvocation> {
  const origin = resolveAzureConfiguredOrigin(request.instance.configuration);
  if (origin === null) return { ok: false, failure: undecodableConfiguration() };

  const address = parseAzureEntryLocalRef(request.localRef, origin);
  if (address === null) return { ok: false, failure: entryOutsideInstance() };

  // The same authorization owner `scan` and `get` use. The viewer read they add
  // on top of it is deliberately not repeated here: no detail plane consumes
  // provider account identity, so paying for it per mounted panel read would buy
  // nothing.
  // One bound for the whole invocation, installed before the first provider
  // boundary so account materialization is inside it too: a connection that
  // hangs while the credential is being materialized strands the panel exactly
  // as a hanging read does.
  const signal = boundDetailRead(context.signal, AZURE_DEVOPS_MOUNTED_DETAIL_DEADLINE_MS);

  const authorized = await authorizeClient({
    services: {
      connectedAccounts: context.services.connectedAccounts,
      transport: toTransport(context.services.http, signal),
      now: () => Date.now(),
    },
    instance: request.instance,
    origin,
    signal,
  });
  if (!authorized.ok) return { ok: false, failure: authorized.failure };

  return {
    ok: true,
    address,
    client: authorized.client,
    dependencies: Object.freeze({ client: authorized.client, signal }),
  };
}

/* ---------------------------------------------------------------- iterations */

/**
 * The one shared iteration read of a mounted detail body.
 *
 * `Activity` and `Files` consume its projection; neither reads the list again.
 * A `currentIterationId` is published only when Azure returned a real 1-based
 * iteration, so nothing downstream can path-address iteration `0`.
 */
export async function readAzureDevOpsIterations(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureIterationsResultV1> {
  const parsed = AzureIterationsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());

  const admitted = await admitAzureDetailInvocation({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const read = await readAzureIterations(admitted.address, admitted.dependencies);
  if (!read.ok) return unavailable(projectAzureSourceFailure(read.failure));

  const { currentIterationId } = read.value;
  return Object.freeze({
    kind: 'iterations' as const,
    rows: read.value.rows,
    ...(currentIterationId === null ? {} : { currentIterationId }),
    omittedRowCount: read.value.omittedRowCount,
    projectionTruncated: read.value.projectionTruncated,
  });
}

/* ------------------------------------------------------------------- commits */

/** One page of the pull request's commits, positioned only by Azure's own token. */
export async function listAzureDevOpsCommits(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureCommitsResultV1> {
  const parsed = AzureCommitsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());

  const admitted = await admitAzureDetailInvocation({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const read = await readAzureCommitsPage({
    ...admitted.address,
    continuationToken: parsed.data.continuationToken ?? null,
  }, admitted.dependencies);
  if (!read.ok) return unavailable(projectAzureSourceFailure(read.failure));

  const { continuationToken } = read.value;
  return Object.freeze({
    kind: 'commits' as const,
    rows: read.value.rows,
    ...(continuationToken === null ? {} : { continuationToken }),
    omittedRowCount: read.value.omittedRowCount,
    projectionTruncated: read.value.projectionTruncated,
  });
}

/* --------------------------------------------------------- iteration changes */

/**
 * One page of one iteration's changed files.
 *
 * The window advances only through the `nextSkip`/`nextTop` Azure issued for the
 * previous page. A caller that supplies neither starts at the beginning; a
 * caller that computed its own offset is not expressible, because this operation
 * never adds to the one it was given.
 */
export async function listAzureDevOpsIterationChanges(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureIterationChangesResultV1> {
  const parsed = AzureIterationChangesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());

  const admitted = await admitAzureDetailInvocation({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const read = await readAzureIterationChangesPage({
    ...admitted.address,
    iterationId: parsed.data.iterationId,
    skip: parsed.data.skip ?? 0,
    top: parsed.data.top ?? AZURE_CHANGES_PAGE_SIZE_V1,
  }, admitted.dependencies);
  if (!read.ok) return unavailable(projectAzureSourceFailure(read.failure));

  const { next } = read.value;
  return Object.freeze({
    kind: 'iterationChanges' as const,
    iterationId: parsed.data.iterationId,
    rows: read.value.rows,
    // Present together or absent together: half a position is an offset the
    // caller would have to complete by guessing.
    ...(next === null ? {} : { nextSkip: next.nextSkip, nextTop: next.nextTop }),
    omittedRowCount: read.value.omittedRowCount,
    projectionTruncated: read.value.projectionTruncated,
  });
}

/* ------------------------------------------------------------------ policies */

/**
 * The pull request's statuses and policy evaluations.
 *
 * The pull request itself is read first because policy evaluations are
 * PROJECT-scoped: their route needs the project this pull request lives in, and
 * that fact exists only in the pull-request body. Guessing it from the
 * configured base would address another project's policies.
 */
export async function readAzureDevOpsPolicies(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzurePoliciesResultV1> {
  const parsed = AzurePoliciesInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());

  const admitted = await admitAzureDetailInvocation({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const pullRequest = await admitted.client.request({
    route: { resource: 'pullRequest', ...admitted.address },
    signal: context.signal,
  });
  if (!pullRequest.ok) {
    return unavailable(projectAzureSourceFailure(pullRequest.failure));
  }
  const scope = readPullRequestScope(pullRequest.body);
  if (scope === null) return unavailable(malformedPullRequest());

  const read = await readAzurePoliciesSurface({
    ...admitted.address,
    project: scope.projectName,
    projectId: scope.projectId,
  }, admitted.dependencies);
  if (!read.ok) return unavailable(projectAzureSourceFailure(read.failure));

  return Object.freeze({
    kind: 'policies' as const,
    statuses: read.value.statuses,
    evaluations: read.value.evaluations,
    evaluationsPartial: read.value.evaluationsPartial,
    omittedRowCount: read.value.omittedRowCount,
    projectionTruncated: read.value.projectionTruncated,
  });
}

/* ------------------------------------------------------------------- threads */

/**
 * Every review thread on the pull request, in one read.
 *
 * The documented endpoint returns them all and publishes no cursor, so this
 * result carries none. The reader's 18-thread and 2-reply windows are local
 * over this one response.
 */
export async function readAzureDevOpsThreads(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureThreadsResultV1> {
  const parsed = AzureThreadsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());

  const admitted = await admitAzureDetailInvocation({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const { iteration, baseIteration } = parsed.data;
  // A lens is a comparison: one half alone is not a narrower query, it is a
  // broken one, so a partial lens is refused rather than half-applied.
  if ((iteration === undefined) !== (baseIteration === undefined)) {
    return unavailable(invalidInput());
  }

  const read = await readAzureThreads({
    ...admitted.address,
    iterationLens: iteration === undefined || baseIteration === undefined
      ? null
      : { iteration, baseIteration },
  }, admitted.dependencies);
  if (!read.ok) return unavailable(projectAzureSourceFailure(read.failure));

  return Object.freeze({
    kind: 'threads' as const,
    rows: read.value.rows,
    omittedRowCount: read.value.omittedRowCount,
    projectionTruncated: read.value.projectionTruncated,
  });
}
