import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
  TriageGetInputV1Schema,
  TriageListInstancesInputV1Schema,
  TriagePrepareReviewWorkspaceInputV1Schema,
  TriageScanInputV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriagePrepareReviewWorkspaceResultV1,
  type TriageScanResultV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  createGithubListedAccountApiClient,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';

import {
  decodeGithubTriageConfiguration,
  GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
  readGithubScanRepositoryKey,
  type GithubTriageConfigurationV1,
} from './configuration.js';
import {
  GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
  readGithubTriageKindId,
} from './contribution.js';
import { classifyGithubTransportFailure, GITHUB_MISSING_LOCATOR_FAILURE } from './errors.js';
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
  toTriageObservation,
  toTriageScanEvidence,
  toTriageScanObservation,
} from './mapping/protocol.js';
import { createGithubRepositoryReader } from './repositories.js';
import { runGithubTriageScan } from './scan/scan.js';
import type { GithubTriageEntryLocalRefV1 } from './types.js';

/**
 * The three GitHub source operations, expressed in the published source ABI.
 *
 * This module is the ONLY Triage boundary in this plugin. Everything below it is
 * GitHub's own vertical — the shared REST client, the five-lane scan, the
 * endpoint-specific `get` ladders — and everything above it is the strict public
 * contract. Credentials appear only inside the client construction below; no
 * materialized header, account ref or provider bag reaches a result.
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

function resolveInstance(instance: TriageConfiguredSourceInstanceV1): ResolvedInstance {
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
 * including the four source-native detail planes, materializes its account
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
  instance: TriageConfiguredSourceInstanceV1,
  context: PluginInvocationContext,
): Promise<
  | Readonly<{ ok: true; client: GithubApiClientV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>
> {
  try {
    return Object.freeze({
      ok: true as const,
      client: await createGithubListedAccountApiClient(context, instance.binding.account),
    });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
    });
  }
}

/**
 * Resolves the one GitHub route from the newest source locator, with a
 * repository-scoped configured instance as the same first-read fallback `get`
 * already owns. Account-wide instances have no configured repository and
 * therefore fail closed when their locator cannot name one.
 */
function resolveGithubTriageRoutingToken(
  configuration: GithubTriageConfigurationV1,
  lastKnownLocator: Readonly<{ routingToken?: unknown }> | undefined,
): string | null {
  const observedRoute = parseGithubRoutingToken(lastKnownLocator?.routingToken);
  return observedRoute === null
    ? readGithubScanRepositoryKey(configuration)
    : buildGithubRepositoryKey(observedRoute);
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
): TriagePrepareReviewWorkspaceResultV1 {
  switch (errorCode) {
    case 'NOT_REPOSITORY':
    case 'INVALID_PATH':
    case 'REMOTE_NOT_FOUND':
      return Object.freeze({ kind: 'workspaceMismatch' as const });
    default:
      return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
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
    dependencies.now === undefined ? {} : { now: dependencies.now },
  );
}

export async function scanGithubTriageSource(
  input: unknown,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1 = {},
): Promise<TriageScanResultV1> {
  const parsed = TriageScanInputV1Schema.safeParse(input);
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

  const result = await runGithubTriageScan({
    page: scanInput.page.kind === 'initial'
      ? Object.freeze({ kind: 'initial' as const, limit: scanInput.page.limit })
      : Object.freeze({
        kind: 'continuation' as const,
        token: scanInput.page.continuation.token,
        maxLimit: MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
      }),
    repositoryKey: readGithubScanRepositoryKey(resolved.configuration),
  }, {
    client: opened.client,
    now: dependencies.now ?? Date.now,
    signal: context.signal,
  });

  if (result.kind === 'failed') {
    return Object.freeze({ kind: 'failed' as const, failure: toTriageFailure(result.failure) });
  }
  // The per-lane read failures behind `partial { lane-unresolved }` stay health evidence
  // rather than becoming a public lane vocabulary.
  const observations = Object.freeze(result.observations.map(toTriageScanObservation));
  const evidence = toTriageScanEvidence(result.evidence);
  if (result.kind === 'complete') {
    return Object.freeze({ kind: 'complete' as const, observations, evidence });
  }
  // The token is this source's own bytes. The target copies it back on the next page
  // without parsing it, and drops it on cancellation, deadline, failure, or restart.
  return Object.freeze({
    kind: 'page' as const,
    observations,
    evidence,
    continuation: Object.freeze({ v: 1 as const, token: result.continuation }),
  });
}

export async function getGithubTriageEntry(
  input: unknown,
  context: PluginInvocationContext,
  dependencies: GithubTriageOperationDependenciesV1 = {},
): Promise<TriageGetResultV1> {
  const parsed = TriageGetInputV1Schema.safeParse(input);
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
  const routingToken = resolveGithubTriageRoutingToken(
    resolved.configuration,
    getInput.lastKnownLocator,
  );
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
    now: dependencies.now ?? Date.now,
    signal: context.signal,
  });
  return toTriageObservation(observation);
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
  const parsed = TriagePrepareReviewWorkspaceInputV1Schema.safeParse(input);
  if (!parsed.success) return Object.freeze({ kind: 'unsupported' as const });
  const preparation = parsed.data;

  context.signal.throwIfAborted();
  if (preparation.workspace === null) {
    // No local state was selected, so no credential, network, local-SCM or
    // fallback path may be touched.
    return Object.freeze({ kind: 'workspaceRequired' as const });
  }
  if (!isGithubPullRequestEntryRef(preparation.entryRef)) {
    return Object.freeze({ kind: 'unsupported' as const });
  }

  const resolved = resolveInstance(preparation.instance);
  if (!resolved.ok) {
    return Object.freeze({ kind: 'refused' as const, reason: 'instanceMoved' as const });
  }
  const routingToken = resolveGithubTriageRoutingToken(
    resolved.configuration,
    preparation.lastKnownLocator,
  );
  const route = routingToken === null ? null : parseGithubRoutingToken(routingToken);
  if (route === null) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }

  const localRef: GithubTriageEntryLocalRefV1 = Object.freeze({
    kindId: 'pull-request',
    collisionScope: preparation.entryRef.collisionScope,
    entryId: preparation.entryRef.entryId,
  });
  const opened = await openClient(preparation.instance, context);
  context.signal.throwIfAborted();
  if (!opened.ok) {
    return Object.freeze({ kind: 'unavailable' as const, reason: 'account' as const });
  }

  const reread = await readGithubPullRequest(
    localRef,
    route,
    createGithubRepositoryReader({ client: opened.client, now: dependencies.now ?? Date.now }),
    { client: opened.client, now: dependencies.now ?? Date.now, signal: context.signal },
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

  const reviewRevision = reread.facts.reviewRevision;
  if (
    reviewRevision.baseSha !== preparation.observed.baseSha
    || reviewRevision.headSha !== preparation.observed.headSha
    || reviewRevision.nativeRevision !== preparation.observed.nativeRevision
  ) {
    return Object.freeze({ kind: 'refused' as const, reason: 'observedHeadMoved' as const });
  }
  const sourceTip = toGithubReviewWorkspaceSourceTip(reread.facts.sourceTip);
  if (sourceTip === null) {
    return Object.freeze({ kind: 'refused' as const, reason: 'pullRequestMoved' as const });
  }

  let materialized;
  try {
    materialized = await context.services.actions.execute(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: preparation.workspace.rootPath,
        displayName: sourceTip.branch,
        sourceTip,
      },
      { signal: context.signal },
    );
  } catch {
    context.signal.throwIfAborted();
    return Object.freeze({ kind: 'unavailable' as const, reason: 'scmResolver' as const });
  }
  context.signal.throwIfAborted();
  if (!materialized.success) {
    return mapGithubReviewWorkspaceMaterializationFailure(materialized.errorCode);
  }
  return Object.freeze({
    kind: 'prepared' as const,
    repositoryPath: materialized.targetPath,
    branch: materialized.branchName,
    created: materialized.created,
    currentness: materialized.currentness,
    // The source only transports the exact reread number. Generic SCM/Reviews
    // remains the one parser and validity owner for the reference grammar.
    pullRequest: Object.freeze({ number: reread.facts.number }),
  });
}
