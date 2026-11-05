import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  isPluginActionApprovalRequestCreated,
} from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { scanTriageSelectedScopeUnitsV1, parseForgeLinkHeader, readForgeLinkHeaderValue, admitForgeRequestUrl } from '@happier-dev/triage-sources/runtime';
import {
  TriageSourceCredentialInputsV1,
  TriageSourceCredentialBindingV1Schema,
  TriageListInstancesInputV1Schema,
  TriageListScopeUnitsResultV1Schema,
  TriageSourceScopeUnitV1Schema,
  encodeTriagePagingTokenV1,
  decodeTriagePagingTokenV1,
  type TriageListScopeUnitsResultV1,
  type TriageConfiguredSourceInstanceV1,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriagePrepareReviewWorkspaceResultV1,
  type TriageScanResultV1,
  type TriageSourceFailureV1,
  type TriageVerifyReviewWorkspaceInputV1,
  type TriageVerifyReviewWorkspaceResultV1,
} from '@happier-dev/triage-protocol/v1';

import {
  createGithubListedAccountApiClient,
  createGithubNativeApiClient,
  decodeGithubJsonResponse,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';
import { GITHUB_PLUGIN_ID, GITHUB_API_ORIGIN } from '../observations/githubProviderContracts.js';

import {
  decodeGithubTriageConfiguration,
  GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
  type GithubTriageConfigurationV1,
} from './configuration.js';
import {
  GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
  readGithubTriageKindId,
} from './contribution.js';
import { classifyGithubTransportFailure, classifyGithubResponseFailure, isGithubSuccessStatus, GITHUB_MISSING_LOCATOR_FAILURE } from './errors.js';
import {
  readGithubPullRequest,
  runGithubTriageGet,
  type GithubPullRequestSourceTipV1,
} from './get.js';
import { listGithubTriageInstances } from './instances.js';
import { buildGithubRepositoryKey, parseGithubRoutingToken } from './locator.js';
import {
  toTriageFailure,
  toTriageLocalRef,
  toTriageGetResult,
  toTriageScanEvidence,
  toTriageScanObservation,
} from './mapping/protocol.js';
import { createGithubRepositoryReader, decodeGithubRepositoryMetadata } from './repositories.js';
import { buildGithubCollisionScope } from './identity.js';
import { runGithubTriageScan } from './scan/scan.js';
import { GITHUB_MAX_PAGE_SIZE_V1, type GithubTriageEntryLocalRefV1 } from './types.js';

/**
 * The GitHub source operations, expressed in the published source ABI.
 *
 * This module is the ONLY Triage boundary in this plugin. Everything below it is
 * GitHub's own vertical — the shared REST client, the five-lane scan, the
 * endpoint-specific `get` ladders — and everything above it is the strict public
 * contract. Materialized credentials and provider-native bags stay inside the
 * client construction below. A get result can route the configured, value-free
 * account reference through its transient comparison source; it is not persisted
 * in the corpus observation.
 */

export type GithubTriageOperationDependenciesV1 = Readonly<{
  /** Injected clock. A provider-directed retry instant is evidence, never a guess. */
  now?: () => number;
}>;

const INVALID_INPUT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_operation_input_invalid',
});

const FOREIGN_BINDING_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_instance_binding_foreign',
});

function readScmWorkspaceVerification(value: unknown): Readonly<{
  targetPath: string;
  sourceHeadSha: string;
}> | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.targetPath === 'string' && typeof record.sourceHeadSha === 'string'
    ? Object.freeze({ targetPath: record.targetPath, sourceHeadSha: record.sourceHeadSha })
    : null;
}

/** Preserve cancellation across the SCM process boundary for both workspace roles. */
function rethrowGithubReviewWorkspaceAbort(error: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (error instanceof Error && error.name === 'AbortError') throw error;
}


export type GithubResolvedTriageInstanceV1 =
  | Readonly<{ ok: true; configuration: GithubTriageConfigurationV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

type ResolvedInstance = GithubResolvedTriageInstanceV1;

/**
 * Accepts only a configured instance whose binding names this source's declared
 * purpose, then decodes its own configuration bytes. A configured instance bound to
 * another purpose is not this source's to reauthorize.
 *
 * It is exported because the source-native detail reads need exactly this
 * admission and must not grow a second, similar-but-different one: the authority
 * an invocation carries is one decision, made here.
 */
export function resolveGithubTriageInstance(
  instance: TriageConfiguredSourceInstanceV1,
): GithubResolvedTriageInstanceV1 {
  return resolveInstance(instance);
}

function resolveInstance(instance: Pick<TriageConfiguredSourceInstanceV1, 'binding' | 'configuration'>): ResolvedInstance {
  if (instance.binding.purpose !== GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose) {
    return Object.freeze({ ok: false as const, failure: FOREIGN_BINDING_FAILURE });
  }
  const decoded = decodeGithubTriageConfiguration(instance.configuration.token);
  return decoded.ok
    ? Object.freeze({ ok: true as const, configuration: decoded.configuration })
    : Object.freeze({ ok: false as const, failure: toTriageFailure(decoded.failure) });
}

/**
 * Materializes the exact configured account for this invocation. The client is the
 * one credential holder and retains nothing beyond the call.
 *
 * Exported for the same reason as the admission above: every GitHub Triage read,
 * including the seven source-native detail planes, materializes its account
 * through this one seam.
 */
export async function openGithubTriageClient(
  instance: TriageConfiguredSourceInstanceV1,
  context: PluginInvocationContext,
): Promise<
  | Readonly<{ ok: true; client: GithubApiClientV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>
> {
  return openClient(instance, context);
}

async function openClient(
  instance: Pick<TriageConfiguredSourceInstanceV1, 'binding'>,
  context: PluginInvocationContext,
): Promise<
  | Readonly<{ ok: true; client: GithubApiClientV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>
> {
  try {
    const binding = TriageSourceCredentialBindingV1Schema.safeParse(instance.binding);
    if (!binding.success) return Object.freeze({ ok: false as const, failure: FOREIGN_BINDING_FAILURE });
    return Object.freeze({
      ok: true as const,
      client: 'account' in binding.data
        ? await createGithubListedAccountApiClient(context, binding.data.account)
        : await createGithubNativeApiClient(context, binding.data.service),
    });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
    });
  }
}

/**
 * Resolves the one GitHub route from the newest source locator.
 *
 * Configuration scopes scans; it is not evidence that one exact entry belongs
 * to that repository. Exact get and workspace preparation therefore fail closed
 * when the selected observation carries no usable route instead of guessing
 * from the configured scan scope.
 */
export async function listGithubTriageScopeUnits(input: unknown, context: PluginInvocationContext): Promise<TriageListScopeUnitsResultV1> {
  const parsed = TriageSourceCredentialInputsV1.listScopeUnits.safeParse(input);
  if (!parsed.success) return { kind: 'failed', failure: INVALID_INPUT_FAILURE };
  const { draft, mode, cursor } = parsed.data;
  const resolved = resolveInstance(draft);
  if (!resolved.ok) return { kind: 'failed', failure: resolved.failure };
  const { selection, units = [] } = resolved.configuration;
  if (mode === 'configured') return { kind: 'page', status: 'complete', selection,
    units: selection.kind === 'all' ? [] : selection.unitIds.map((id) => units.find((unit) => unit.id === id)
      ?? { id, label: id }) };
  const query = parsed.data.query?.trim() ?? '';
  const first = new URL(query === '' ? '/user/repos' : '/search/repositories', GITHUB_API_ORIGIN);
  first.searchParams.set('per_page', String(GITHUB_MAX_PAGE_SIZE_V1));
  if (query !== '') first.searchParams.set('q', query);
  const admits = (candidate: unknown): candidate is string => {
    if (typeof candidate !== 'string' || admitForgeRequestUrl(candidate, GITHUB_API_ORIGIN) === null) return false;
    const url = new URL(candidate);
    if (url.pathname !== first.pathname || !/^[1-9][0-9]*$/u.test(url.searchParams.get('page') ?? '')) return false;
    url.searchParams.delete('page'); url.searchParams.sort();
    const expected = new URL(first); expected.searchParams.sort();
    return url.search === expected.search;
  };
  let url = first.toString();
  if (cursor !== undefined) {
    const retained = decodeTriagePagingTokenV1(cursor.token);
    if (retained === null || retained.v !== 1 || retained.query !== query || retained.localInstanceKey !== draft.localInstanceKey
      || !pluginJsonValuesEqual(retained.binding, draft.binding) || !admits(retained.url)) return { kind: 'failed', failure: INVALID_INPUT_FAILURE };
    url = retained.url;
  }
  const opened = await openClient(draft, context);
  if (!opened.ok) return { kind: 'failed', failure: opened.failure };
  try {
    const response = await opened.client.request({ url });
    if (!isGithubSuccessStatus(response.status)) return { kind: 'failed', failure: toTriageFailure(classifyGithubResponseFailure(response, Date.now())) };
    const body = decodeGithubJsonResponse(response);
    const search = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Readonly<Record<string, unknown>> : null;
    const rows = query === '' ? body : search?.items;
    if (!Array.isArray(rows)) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_repository_directory_invalid' } };
    const projected = rows.map((row) => {
      const repository = decodeGithubRepositoryMetadata(row);
      return repository === null || repository.repositoryKey === null ? null : TriageSourceScopeUnitV1Schema.safeParse({
        id: repository.repositoryKey, label: repository.repositoryKey, collisionScope: buildGithubCollisionScope(repository.repositoryId),
      });
    });
    const listed = projected.flatMap((unit) => unit?.success ? [unit.data] : []);
    const link = parseForgeLinkHeader(readForgeLinkHeaderValue(response.headers));
    const next = link.kind === 'parsed' ? link.links.next : undefined;
    const nextToken = next !== undefined && next !== url && admits(next) ? encodeTriagePagingTokenV1({
      v: 1, binding: draft.binding, localInstanceKey: draft.localInstanceKey, query, url: next,
    }) : null;
    const incomplete = listed.length !== rows.length || link.kind === 'malformed' || next !== undefined || search?.incomplete_results === true
      || (typeof search?.total_count === 'number' && search.total_count > Number(new URL(url).searchParams.get('page') ?? '1') * GITHUB_MAX_PAGE_SIZE_V1);
    return TriageListScopeUnitsResultV1Schema.parse(incomplete
      ? { kind: 'page', status: 'partial', selection, units: listed, ...(nextToken === null ? {} : { nextCursor: { v: 1, token: nextToken } }) }
      : { kind: 'page', status: 'complete', selection, units: listed });
  } catch (error) {
    context.signal.throwIfAborted();
    return { kind: 'failed', failure: toTriageFailure(classifyGithubTransportFailure(error)) };
  }
}

function resolveGithubTriageRoutingToken(
  lastKnownLocator: Readonly<{ routingToken?: unknown }> | undefined,
): string | null {
  const observedRoute = parseGithubRoutingToken(lastKnownLocator?.routingToken);
  return observedRoute === null ? null : buildGithubRepositoryKey(observedRoute);
}

function isGithubPullRequestEntryRef(entryRef: Readonly<{
  source: Readonly<{ pluginId: string; localId: string }>;
  kindId: string;
}>): boolean {
  return entryRef.source.pluginId === GITHUB_PLUGIN_ID
    && entryRef.source.localId === GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1
    && entryRef.kindId === 'pull-request';
}

function hasSameGithubLocalRef(
  left: GithubTriageEntryLocalRefV1,
  right: GithubTriageEntryLocalRefV1,
): boolean {
  return left.kindId === right.kindId
    && left.collisionScope === right.collisionScope
    && left.entryId === right.entryId;
}

const GIT_OBJECT_ID_PATTERN = /^[0-9a-fA-F]{7,64}$/u;

/**
 * Projects only the editable source-side facts GitHub returned from its one
 * current PR reread. The target/base repository and GitHub's synthetic PR ref
 * never enter this boundary.
 */
function toGithubReviewWorkspaceSourceTip(
  source: GithubPullRequestSourceTipV1,
): Readonly<{
  repository: Readonly<{
    kind: 'github';
    deployment: string;
    repository: string;
  }>;
  cloneUrl: string;
  branch: string;
  sourceHeadSha: string;
  fetchRef: string;
}> | null {
  // The source endpoint says which clone URL it means. It must at least agree
  // with the GitHub deployment it declares; a malformed or cross-origin URL is
  // not repaired into a guessed remote.
  let cloneUrl: URL;
  try {
    cloneUrl = new URL(source.cloneUrl);
  } catch {
    return null;
  }
  if (
    cloneUrl.origin !== GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1
    || cloneUrl.username
    || cloneUrl.password
    || cloneUrl.search
    || cloneUrl.hash
    || buildGithubRepositoryKey({ owner: source.owner, name: source.name }) === null
    || !GIT_OBJECT_ID_PATTERN.test(source.sourceHeadSha)
  ) {
    return null;
  }
  return Object.freeze({
    repository: Object.freeze({
      kind: 'github' as const,
      deployment: GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
      repository: `${source.owner}/${source.name}`,
    }),
    // Keep the provider-returned URL rather than constructing an equivalent
    // path: the generic SCM owner proves it matches a local source remote.
    cloneUrl: source.cloneUrl,
    branch: source.branch,
    sourceHeadSha: source.sourceHeadSha,
    fetchRef: `refs/heads/${source.branch}`,
  });
}

function mapGithubReviewWorkspaceMaterializationFailure(
  errorCode: string,
): Extract<
  TriagePrepareReviewWorkspaceResultV1,
  Readonly<{ kind: 'workspaceMismatch' | 'unavailable' }>
> {
  switch (errorCode) {
    case 'NOT_REPOSITORY':
    case 'INVALID_PATH':
    case 'REMOTE_NOT_FOUND':
      return Object.freeze({ kind: 'workspaceMismatch' as const });
    default:
      return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
}

type GithubReviewWorkspaceRequestV1 = Readonly<{
  instance: TriageVerifyReviewWorkspaceInputV1['instance'];
  entryRef: TriageVerifyReviewWorkspaceInputV1['entryRef'];
  lastKnownLocator: TriageVerifyReviewWorkspaceInputV1['lastKnownLocator'];
  observed: TriageVerifyReviewWorkspaceInputV1['observed'];
}>;

type GithubAuthorizedReviewWorkspaceV1 =
  | Readonly<{
    kind: 'authorized';
    sourceTip: NonNullable<ReturnType<typeof toGithubReviewWorkspaceSourceTip>>;
    pullRequest: Readonly<{ number: number }>;
  }>
  | Readonly<{ kind: 'unavailable'; reason: 'account' }>
  | Readonly<{ kind: 'refused'; reason: 'instanceMoved' | 'pullRequestMoved' | 'observedHeadMoved' }>;

/** One provider authority path shared by initial preparation and final verification. */
async function authorizeGithubReviewWorkspace(
  request: GithubReviewWorkspaceRequestV1,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1,
): Promise<GithubAuthorizedReviewWorkspaceV1> {
  if (!isGithubPullRequestEntryRef(request.entryRef)) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }
  const resolved = resolveInstance(request.instance);
  if (!resolved.ok) {
    return Object.freeze({ kind: 'refused' as const, reason: 'instanceMoved' as const });
  }
  const routingToken = resolveGithubTriageRoutingToken(request.lastKnownLocator);
  const route = routingToken === null ? null : parseGithubRoutingToken(routingToken);
  if (route === null) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }
  const localRef: GithubTriageEntryLocalRefV1 = Object.freeze({
    kindId: 'pull-request',
    collisionScope: request.entryRef.collisionScope,
    entryId: request.entryRef.entryId,
  });
  const opened = await openClient(request.instance, context);
  context.signal.throwIfAborted();
  if (!opened.ok) return Object.freeze({ kind: 'unavailable' as const, reason: 'account' as const });

  const reread = await readGithubPullRequest(
    localRef,
    route,
    createGithubRepositoryReader({
      client: opened.client,
      now: dependencies.now ?? (() => context.invokedAtMs),
    }),
    {
      client: opened.client,
      now: dependencies.now ?? (() => context.invokedAtMs),
      signal: context.signal,
    },
  );
  context.signal.throwIfAborted();
  if (
    reread.observation.kind !== 'present'
    || reread.facts === null
    || !hasSameGithubLocalRef(reread.observation.localRef, localRef)
    || reread.facts.reviewRevision === null
    || reread.facts.sourceTip === null
  ) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }
  const revision = reread.facts.reviewRevision;
  if (
    revision.baseSha !== request.observed.baseSha
    || revision.headSha !== request.observed.headSha
    || revision.nativeRevision !== request.observed.nativeRevision
  ) {
    return Object.freeze({ kind: 'refused' as const, reason: 'observedHeadMoved' as const });
  }
  const sourceTip = toGithubReviewWorkspaceSourceTip(reread.facts.sourceTip);
  if (sourceTip === null) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }
  return Object.freeze({
    kind: 'authorized' as const,
    sourceTip,
    pullRequest: Object.freeze({ number: reread.facts.number }),
  });
}

export async function listGithubTriageInstancesOperation(
  input: unknown,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1 = {},
): Promise<TriageListInstancesResultV1> {
  const parsed = TriageListInstancesInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({ kind: 'failed' as const, failure: INVALID_INPUT_FAILURE });
  }
  return await listGithubTriageInstances(
    context,
    { now: dependencies.now ?? (() => context.invokedAtMs) },
  );
}

type GithubPublicScanPageV1 = Extract<TriageScanResultV1, Readonly<{ kind: 'page' }>>;

/** Final Action-envelope settlement for one source-minted GitHub scan page. */
export function settleGithubTriageScanPage(
  observations: GithubPublicScanPageV1['observations'],
  evidence: GithubPublicScanPageV1['evidence'],
  continuationToken: string,
): TriageScanResultV1 {
  const pageResult: TriageScanResultV1 = Object.freeze({
    kind: 'page' as const,
    observations,
    evidence,
    continuation: Object.freeze({ v: 1 as const, token: continuationToken }),
  });
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(pageResult)) return pageResult;

  return Object.freeze({
    kind: 'complete' as const,
    observations,
    evidence: Object.freeze({
      kind: 'partial' as const,
      reason: 'continuation-unavailable' as const,
      ...(evidence.kind === 'partial' && evidence.omittedItemCount !== undefined
        ? { omittedItemCount: evidence.omittedItemCount }
        : {}),
    }),
  });
}

export async function scanGithubTriageSource(
  input: unknown,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1 = {},
): Promise<TriageScanResultV1> {
  const parsed = TriageSourceCredentialInputsV1.scan.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({ kind: 'failed' as const, failure: INVALID_INPUT_FAILURE });
  }
  const scanInput = parsed.data;
  const resolved = resolveInstance(scanInput.instance);
  if (!resolved.ok) {
    return Object.freeze({ kind: 'failed' as const, failure: resolved.failure });
  }
  const opened = await openClient(scanInput.instance, context);
  if (!opened.ok) {
    return Object.freeze({ kind: 'failed' as const, failure: opened.failure });
  }

  const now = dependencies.now ?? (() => context.invokedAtMs);
  const repositories = createGithubRepositoryReader({ client: opened.client, now });
  return await scanTriageSelectedScopeUnitsV1({
    instance: scanInput.instance, selection: resolved.configuration.selection, page: scanInput.page,
    scan: async (unitId, page) => {
      const repositoryKey = unitId;
      const result = await runGithubTriageScan({
        page: page.kind === 'initial' ? { kind: 'initial', limit: page.limit }
          : { kind: 'continuation', token: page.continuation.token },
        repositoryKey,
        ...(scanInput.completed?.kindIds.includes('issue') ? { completedSinceMs: scanInput.completed.sinceMs } : {}),
      }, { client: opened.client, now, signal: context.signal, repositories });
      if (result.kind === 'failed') return { kind: 'failed', failure: toTriageFailure(result.failure) };
      const observations = result.observations.map(toTriageScanObservation);
      const evidence = toTriageScanEvidence(result.evidence);
      return result.kind === 'complete' ? { kind: 'complete', observations, evidence }
        : settleGithubTriageScanPage(observations, evidence, result.continuation);
    },
  });
}

export async function getGithubTriageEntry(
  input: unknown,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1 = {},
): Promise<TriageGetResultV1> {
  const parsed = TriageSourceCredentialInputsV1.get.safeParse(input);
  if (!parsed.success) {
    // A `get` cannot report an unresolved observation without a valid local ref, so
    // an unparseable input is refused rather than answered about an unknown entry.
    throw new Error('github_triage_get_input_invalid');
  }
  const getInput = parsed.data;
  const kindId = readGithubTriageKindId(getInput.localRef.kindId);
  const localRef: GithubTriageEntryLocalRefV1 | null = kindId === null ? null : Object.freeze({
    kindId,
    collisionScope: getInput.localRef.collisionScope,
    entryId: getInput.localRef.entryId,
  });
  if (localRef === null) {
    return Object.freeze({
      kind: 'unresolved' as const,
      localRef: toTriageLocalRef(getInput.localRef as GithubTriageEntryLocalRefV1),
      failure: Object.freeze({
        class: 'unsupportedContract' as const,
        code: 'github_kind_undeclared',
      }),
    });
  }

  const resolved = resolveInstance(getInput.instance);
  if (!resolved.ok) {
    return Object.freeze({
      kind: 'unresolved' as const,
      localRef: toTriageLocalRef(localRef),
      failure: resolved.failure,
    });
  }
  // `lastKnownLocator` is the newest locator the target observed for THIS entry, and
  // it is the only evidence that can name the repository of an entry an account-wide
  // scan discovered: the configured instance names no repository at all, and §6 forbids
  // recovering one by parsing `collisionScope`. The same owner resolves this route for
  // `get` and review-workspace preparation, so either path fails closed rather than
  // guessing from identity or display text.
  const routingToken = resolveGithubTriageRoutingToken(getInput.lastKnownLocator);
  if (routingToken === null) {
    return Object.freeze({
      kind: 'unresolved' as const,
      localRef: toTriageLocalRef(localRef),
      failure: toTriageFailure(GITHUB_MISSING_LOCATOR_FAILURE),
    });
  }

  const opened = await openClient(getInput.instance, context);
  if (!opened.ok) {
    return Object.freeze({
      kind: 'unresolved' as const,
      localRef: toTriageLocalRef(localRef),
      failure: opened.failure,
    });
  }

  const observation = await runGithubTriageGet({ localRef, routingToken }, {
    client: opened.client,
    now: dependencies.now ?? (() => context.invokedAtMs),
    signal: context.signal,
  });
  return toTriageGetResult(observation, getInput.instance);
}

/**
 * Reauthorizes and rereads one selected GitHub pull request before it invokes
 * exactly one source-neutral local materialization action. GitHub owns all
 * provider/currentness facts above; generic SCM owns every filesystem, remote,
 * fetch and worktree decision below.
 */
export async function prepareGithubTriageReviewWorkspace(
  input: unknown,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1 = {},
): Promise<TriagePrepareReviewWorkspaceResultV1> {
  const parsed = TriageSourceCredentialInputsV1.prepareReviewWorkspace.safeParse(input);
  if (!parsed.success) return Object.freeze({ kind: 'unsupported' as const });
  const preparation = parsed.data;

  context.signal.throwIfAborted();
  if (preparation.workspace === undefined) {
    // No local state was selected, so no credential, network, local-SCM or
    // fallback path may be touched.
    return Object.freeze({ kind: 'workspaceRequired' as const });
  }
  if (!isGithubPullRequestEntryRef(preparation.entryRef)) {
    return Object.freeze({ kind: 'unsupported' as const });
  }
  const authorized = await authorizeGithubReviewWorkspace(preparation, context, dependencies);
  if (authorized.kind !== 'authorized') return authorized;

  let materialized;
  try {
    materialized = await context.services.actions.execute(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: preparation.workspace.rootPath,
        displayName: authorized.sourceTip.branch,
        sourceTip: authorized.sourceTip,
      },
      { signal: context.signal },
    );
  } catch (error) {
    rethrowGithubReviewWorkspaceAbort(error, context.signal);
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  context.signal.throwIfAborted();
  // A policy deferral means the canonical SCM owner never materialized a
  // workspace, so this preparation is unavailable rather than prepared.
  if (isPluginActionApprovalRequestCreated(materialized)) {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  if (!materialized.success) {
    return mapGithubReviewWorkspaceMaterializationFailure(materialized.errorCode);
  }
  if ('verification' in materialized) {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  return Object.freeze({
    kind: 'prepared' as const,
    repositoryPath: materialized.targetPath,
    branch: materialized.branchName,
    created: materialized.created,
    currentness: materialized.currentness,
    // The source only transports the exact reread number. Generic SCM/Reviews
    // remains the one parser and validity owner for the reference grammar.
    pullRequest: authorized.pullRequest,
  });
}

/**
 * Reauthorizes the exact provider revision and then asks the canonical SCM
 * owner to resolve the already prepared checkout's local HEAD. Verification is
 * a read arm of the incumbent materialization Action: it never fetches, moves,
 * recreates, or substitutes a workspace.
 */
export async function verifyGithubTriageReviewWorkspace(
  input: unknown,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1 = {},
): Promise<TriageVerifyReviewWorkspaceResultV1> {
  const parsed = TriageSourceCredentialInputsV1.verifyReviewWorkspace.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }
  const verification = parsed.data;
  context.signal.throwIfAborted();

  const authorized = await authorizeGithubReviewWorkspace(verification, context, dependencies);
  if (authorized.kind !== 'authorized') return authorized;
  if (
    !('kind' in verification.prepared)
    && !pluginJsonValuesEqual(authorized.pullRequest, verification.prepared.pullRequest)
  ) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }

  let localResult;
  try {
    localResult = await context.services.actions.execute(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: verification.workspace.rootPath,
        displayName: authorized.sourceTip.branch,
        sourceTip: authorized.sourceTip,
        verification: { targetPath: verification.prepared.repositoryPath },
      },
      { signal: context.signal },
    );
  } catch (error) {
    rethrowGithubReviewWorkspaceAbort(error, context.signal);
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  context.signal.throwIfAborted();
  // A policy deferral means the canonical SCM owner never reverified the
  // prepared workspace; it stays unavailable rather than claiming a result.
  if (isPluginActionApprovalRequestCreated(localResult)) {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  if (!localResult.success) {
    return mapGithubReviewWorkspaceMaterializationFailure(localResult.errorCode);
  }
  if (!('verification' in localResult)) {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  const resolved = readScmWorkspaceVerification(localResult.verification);
  if (resolved === null) {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  if (resolved.targetPath !== verification.prepared.repositoryPath) {
    return Object.freeze({ kind: 'workspaceMismatch' as const });
  }
  if (resolved.sourceHeadSha.toLowerCase() !== authorized.sourceTip.sourceHeadSha.toLowerCase()) {
    return Object.freeze({ kind: 'refused' as const, reason: 'observedHeadMoved' as const });
  }
  return Object.freeze({ kind: 'verified' as const, pullRequest: authorized.pullRequest });
}
