import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
  TriageGetInputV1Schema,
  TriageListInstancesInputV1Schema,
  TriageScanInputV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriageScanResultV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  createGithubListedAccountApiClient,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';

import {
  decodeGithubTriageConfiguration,
  readGithubScanRepositoryKey,
  type GithubTriageConfigurationV1,
} from './configuration.js';
import {
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
  readGithubTriageKindId,
} from './contribution.js';
import { classifyGithubTransportFailure, GITHUB_MISSING_LOCATOR_FAILURE } from './errors.js';
import { runGithubTriageGet } from './get.js';
import { listGithubTriageInstances } from './instances.js';
import { buildGithubRepositoryKey, parseGithubRoutingToken } from './locator.js';
import {
  toTriageFailure,
  toTriageLocalRef,
  toTriageObservation,
  toTriageScanEvidence,
  toTriageScanObservation,
} from './mapping/protocol.js';
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
  // The route comes only from current source evidence, in one order.
  //
  // `lastKnownLocator` is the newest locator the target observed for THIS entry, and
  // it is the only evidence that can name the repository of an entry an account-wide
  // scan discovered: the configured instance names no repository at all, and §6 forbids
  // recovering one by parsing `collisionScope`. This source stays the only parser of
  // its own opaque token, and the locator grants no authority — the account is
  // rematerialized and the response is validated against the requested ref before
  // anything is called `present`, so a stale token yields `unresolved`, never a wrong
  // `present`. A repository-scoped configured instance is the fallback for a first read
  // the target has never observed. With neither, the answer is `unresolved` with no
  // outbound call, and no path is guessed from identity or display text.
  const observedRoute = parseGithubRoutingToken(getInput.lastKnownLocator?.routingToken);
  const routingToken = observedRoute === null
    ? readGithubScanRepositoryKey(resolved.configuration)
    : buildGithubRepositoryKey(observedRoute);
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
