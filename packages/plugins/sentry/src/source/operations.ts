/**
 * The three bound Triage source operations (`CONTRACT.md` §3.1, §5;
 * `SENTRY.md` §2.4, §3, §4).
 *
 * Each operation is the whole vertical for one Action invocation: it validates
 * the published input, resolves the exact account's route, materializes that
 * exact account inside one request closure, and projects the Sentry-owned
 * result into the published contract. It owns no registry, cache, scheduler, or
 * second route authority, and it never enumerates Actions or writes configured
 * state — Settings owns every configuration write through the target's
 * administration Action.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MAX_TRIAGE_INSTANCE_DRAFTS_V1,
  TriageGetInputV1Schema,
  TriageListInstancesInputV1Schema,
  TriageScanInputV1Schema,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriageScanResultV1,
  type TriageSourceEntryLocalRefV1,
  type TriageSourceFailureV1,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

import {
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_ENTRY_KIND_ID,
  SENTRY_FAILURE_CODES,
  SENTRY_ORGANIZATIONS_PAGE_SIZE,
  type SentryFailureV1,
} from '../sentryContracts.js';
import { createSentryApiClient, type SentryApiClientV1 } from '../api/sentryApiClient.js';
import { classifySentryFailure } from '../api/sentryFailure.js';
import { parseSentryLinkHeader } from '../api/sentryLinkHeader.js';
import { buildSentryIssueUrl } from '../api/sentryRoutes.js';
import { resolveSentryAccountRoute } from '../auth/sentryAccountRoute.js';
import type { SentryDeploymentV1 } from '../auth/sentryOrigin.js';
import { resolveSentryGetOutcome } from '../entries/getIssueOutcome.js';
import {
  deriveSentryCollisionScope,
  isSentryNumericId,
  type SentryInvokedInstanceV1,
} from '../instances/sentryCollisionScope.js';
import {
  decodeSentryInstanceConfiguration,
  decodeSentryLocalInstanceKey,
  encodeSentryInstanceConfiguration,
  encodeSentryLocalInstanceKey,
} from '../instances/sentryInstanceConfiguration.js';
import {
  parseSentryOrganizationsPage,
  type SentryOrganizationV1,
} from '../instances/sentryOrganizations.js';
import { executeSentryScanPage } from '../scan/scanIssuesPage.js';

import {
  SENTRY_MOVING_SCAN_REASON,
  toTriageFailure,
  toTriageLocalRef,
  toTriagePresentObservation,
  toTriageScanEvidence,
  toTriageScanObservation,
} from './observation.js';

type SentryAccountBindingV1 = Readonly<{
  purpose: string;
  account: ConnectedAccountRef;
}>;

type SentryInstanceFailureV1 = Readonly<{
  binding: SentryAccountBindingV1;
  localInstanceKey?: string;
  failure: TriageSourceFailureV1;
}>;

const UNSUPPORTED_CONTRACT = 'unsupportedContract' as const;

export function sourceFailure(
  code: string,
  failureClass = UNSUPPORTED_CONTRACT,
): TriageSourceFailureV1 {
  return Object.freeze({ class: failureClass, code });
}

/**
 * The one admission rule every entry-scoped invocation shares.
 *
 * `get` and each detail read receive the same two values — a configured instance
 * and a local ref — and must answer the same question before a request exists:
 * does this ref actually belong to the instance that was invoked? Routing,
 * configuration agreement, scope agreement and id shape are checked here once,
 * so a detail read can never reach an issue through an instance whose scope
 * would have refused it.
 */
export function admitSentryEntryInvocation(input: Readonly<{
  localInstanceKey: string;
  configurationToken: string;
  localRef: Readonly<{ kindId: string; collisionScope: string; entryId: string }>;
}>): Readonly<{ ok: true; instance: SentryInvokedInstanceV1; deployment: SentryDeploymentV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }> {
  const routed = resolveInstanceDeployment(input.localInstanceKey);
  if (!routed.ok) {
    return Object.freeze({ ok: false as const, failure: toTriageFailure(routed.failure) });
  }
  const configuration = decodeSentryInstanceConfiguration(input.configurationToken);
  if (
    !configuration.ok
    || configuration.configuration.organizationId !== routed.instance.organizationId
  ) {
    return Object.freeze({
      ok: false as const,
      failure: sourceFailure(SENTRY_FAILURE_CODES.invokedOrganizationMismatch),
    });
  }
  // A ref from another deployment or organization is refused before a request
  // is built, never re-scoped onto this instance.
  if (
    input.localRef.kindId !== SENTRY_ENTRY_KIND_ID
    || input.localRef.collisionScope !== deriveSentryCollisionScope(routed.instance)
  ) {
    return Object.freeze({
      ok: false as const,
      failure: sourceFailure(SENTRY_FAILURE_CODES.invokedOrganizationMismatch),
    });
  }
  if (!isSentryNumericId(input.localRef.entryId)) {
    return Object.freeze({
      ok: false as const,
      failure: sourceFailure(SENTRY_FAILURE_CODES.responseUnparseable),
    });
  }
  return Object.freeze({
    ok: true as const,
    instance: routed.instance,
    deployment: routed.deployment,
  });
}

/** The configured-instance route is the origin its durable local key encodes. */
export function resolveInstanceDeployment(
  localInstanceKey: string,
): Readonly<{ ok: true; instance: SentryInvokedInstanceV1; deployment: SentryDeploymentV1 }>
  | Readonly<{ ok: false; failure: SentryFailureV1 }> {
  const decoded = decodeSentryLocalInstanceKey(localInstanceKey);
  if (!decoded.ok) {
    return Object.freeze({
      ok: false as const,
      failure: Object.freeze({
        class: UNSUPPORTED_CONTRACT,
        code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
      }),
    });
  }
  const route = resolveSentryAccountRoute([decoded.instance.deploymentOrigin]);
  return route.ok
    ? Object.freeze({ ok: true as const, instance: decoded.instance, deployment: route.deployment })
    : Object.freeze({ ok: false as const, failure: route.failure });
}

function organizationsUrl(origin: string, cursor?: string): string {
  const url = new URL('/api/0/organizations/', origin);
  url.searchParams.set('per_page', String(SENTRY_ORGANIZATIONS_PAGE_SIZE));
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  return url.toString();
}

function organizationDisplayLabel(organization: SentryOrganizationV1): string {
  return organization.name ?? organization.slug ?? organization.organizationId;
}

function buildDraft(input: Readonly<{
  binding: SentryAccountBindingV1;
  deployment: SentryDeploymentV1;
  organization: SentryOrganizationV1;
}>): TriageSourceInstanceDraftV1 | null {
  const instance: SentryInvokedInstanceV1 = {
    deploymentOrigin: input.deployment.origin,
    organizationId: input.organization.organizationId,
  };
  try {
    return Object.freeze({
      v: 1 as const,
      binding: input.binding,
      localInstanceKey: encodeSentryLocalInstanceKey(instance),
      // An explicit origin or region change is reconfiguration, never a hidden
      // alias migration, so this key is locator-derived rather than stable.
      keyStability: 'locatorDerived' as const,
      configuration: Object.freeze({
        v: 1 as const,
        token: encodeSentryInstanceConfiguration({
          v: 1,
          organizationId: input.organization.organizationId,
          projectScope: { kind: 'allAccessible' },
          environmentScope: { kind: 'all' },
        }),
      }),
      locator: Object.freeze({
        v: 1 as const,
        displayLabel: organizationDisplayLabel(input.organization),
      }),
    }) as TriageSourceInstanceDraftV1;
  } catch {
    return null;
  }
}

/**
 * Walks one exact account's organization listing.
 *
 * Every page is bounded, same-origin, strictly forward, and carries the
 * invocation's signal through the shared client. A missing `Link` on this
 * cursor-capable endpoint is reported rather than read as a finished walk.
 */
async function collectAccountCandidates(input: Readonly<{
  client: SentryApiClientV1;
  binding: SentryAccountBindingV1;
  deployment: SentryDeploymentV1;
  remainingCapacity: number;
  nowMs: number;
}>): Promise<Readonly<{
  candidates: readonly TriageSourceInstanceDraftV1[];
  failures: readonly SentryInstanceFailureV1[];
  capReached: boolean;
}>> {
  const candidates: TriageSourceInstanceDraftV1[] = [];
  const failures: SentryInstanceFailureV1[] = [];
  const requestedCursors = new Set<string>();
  let cursor: string | undefined;
  let capReached = false;

  const fail = (failure: TriageSourceFailureV1): void => {
    failures.push(Object.freeze({ binding: input.binding, failure }));
  };

  for (;;) {
    const url = organizationsUrl(input.deployment.origin, cursor);
    const outcome = await input.client.request({ url, operation: 'organizations' });
    if (outcome.kind === 'failed') {
      fail(toTriageFailure(outcome.failure));
      break;
    }
    const { response } = outcome;
    if (response.status !== 200) {
      fail(toTriageFailure(classifySentryFailure({
        kind: 'status',
        operation: 'organizations',
        nowMs: input.nowMs,
        response,
      })));
      break;
    }

    let body: unknown;
    try {
      body = JSON.parse(response.bodyText);
    } catch {
      fail(toTriageFailure(classifySentryFailure({
        kind: 'unparseable',
        operation: 'organizations',
      })));
      break;
    }

    const page = parseSentryOrganizationsPage({ deployment: input.deployment, body });
    for (const organization of page.organizations) {
      if (candidates.length >= input.remainingCapacity) {
        capReached = true;
        break;
      }
      const draft = buildDraft({
        binding: input.binding,
        deployment: input.deployment,
        organization,
      });
      if (draft === null) {
        fail(sourceFailure(SENTRY_FAILURE_CODES.malformedOrganizationRow));
        continue;
      }
      candidates.push(draft);
    }
    if (page.failure !== null) fail(toTriageFailure(page.failure));
    if (capReached) break;

    const link = parseSentryLinkHeader(response.headers);
    if (!link.present) {
      fail(sourceFailure(SENTRY_FAILURE_CODES.paginationHeaderAbsent));
      break;
    }
    const next = link.next;
    if (next === null || !next.hasResults) break;
    if (next.cursor === null || next.cursor === '') {
      fail(sourceFailure(SENTRY_FAILURE_CODES.paginationCursorMalformed));
      break;
    }
    if (requestedCursors.has(next.cursor)) {
      fail(sourceFailure(SENTRY_FAILURE_CODES.paginationCursorNotAdvancing));
      break;
    }
    requestedCursors.add(next.cursor);
    cursor = next.cursor;
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    failures: Object.freeze(failures),
    capReached,
  });
}

function compareAccounts(left: ConnectedAccountRef, right: ConnectedAccountRef): number {
  const leftKey = `${left.service.pluginId} ${left.service.localId} ${left.accountId}`;
  const rightKey = `${right.service.pluginId} ${right.service.localId} ${right.accountId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * `listInstances` returns Settings candidates only. It performs no
 * configured-instance lifecycle write on a matching, missing, newly observed or
 * no-longer-observed tuple.
 */
export async function listSentryInstances(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageListInstancesResultV1> {
  TriageListInstancesInputV1Schema.parse(input);
  const nowMs = Date.now();

  const listed = await context.services.connectedAccounts.listAccounts({
    purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
    limit: MAX_TRIAGE_INSTANCE_DRAFTS_V1,
  }, { signal: context.signal });

  const candidates: TriageSourceInstanceDraftV1[] = [];
  const failures: SentryInstanceFailureV1[] = [];
  let capReached = false;

  const accounts = [...listed.accounts]
    .sort((left, right) => compareAccounts(left.account, right.account));

  for (const entry of accounts) {
    if (capReached) break;
    const binding: SentryAccountBindingV1 = Object.freeze({
      purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      account: entry.account,
    });
    const route = resolveSentryAccountRoute(entry.connectedAccountOrigins);
    if (!route.ok) {
      failures.push(Object.freeze({ binding, failure: toTriageFailure(route.failure) }));
      continue;
    }
    const client = await createSentryApiClient(context, {
      account: entry.account,
      deployment: route.deployment,
      nowMs: () => nowMs,
    });
    const walked = await collectAccountCandidates({
      client,
      binding,
      deployment: route.deployment,
      remainingCapacity: MAX_TRIAGE_INSTANCE_DRAFTS_V1 - candidates.length,
      nowMs,
    });
    candidates.push(...walked.candidates);
    failures.push(...walked.failures);
    capReached = walked.capReached;
  }

  const bounded = Object.freeze(failures.slice(0, MAX_TRIAGE_INSTANCE_DRAFTS_V1));

  if (capReached) {
    return Object.freeze({
      kind: 'incomplete' as const,
      candidates: Object.freeze(candidates),
      failures: bounded,
      failure: sourceFailure(SENTRY_FAILURE_CODES.instanceCapReached),
    });
  }
  if (listed.status === 'truncated') {
    // The incumbent listing has no resumable cursor, so an elision can never be
    // reported as complete discovery — and it never retires anything either.
    return Object.freeze({
      kind: 'incomplete' as const,
      candidates: Object.freeze(candidates),
      failures: bounded,
      failure: sourceFailure(SENTRY_FAILURE_CODES.accountListTruncated),
    });
  }
  return Object.freeze({
    kind: 'complete' as const,
    candidates: Object.freeze(candidates),
    failures: bounded,
  });
}

/** One provider page of the V1 full scan for one exact configured instance. */
export async function scanSentrySource(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageScanResultV1> {
  const parsed = TriageScanInputV1Schema.parse(input);
  const failed = (failure: TriageSourceFailureV1): TriageScanResultV1 => Object.freeze({
    kind: 'failed' as const,
    failure,
  });

  const routed = resolveInstanceDeployment(parsed.instance.localInstanceKey);
  if (!routed.ok) return failed(toTriageFailure(routed.failure));

  const configuration = decodeSentryInstanceConfiguration(parsed.instance.configuration.token);
  if (
    !configuration.ok
    || configuration.configuration.organizationId !== routed.instance.organizationId
  ) {
    return failed(sourceFailure(SENTRY_FAILURE_CODES.invokedOrganizationMismatch));
  }

  const client = await createSentryApiClient(context, {
    account: parsed.instance.binding.account,
    deployment: routed.deployment,
    nowMs: () => Date.now(),
  });

  const page = await executeSentryScanPage({
    client,
    configured: routed.instance,
    // The mutable organization slug is locator presentation only and is never
    // recovered from configuration or a response to route a request.
    organizationSlug: null,
    page: parsed.page.kind === 'initial'
      ? { kind: 'initial', scanLimit: parsed.page.limit }
      : { kind: 'continuation', token: parsed.page.continuation.token },
    nowMs: Date.now(),
  });

  if (page.kind === 'failed') return failed(toTriageFailure(page.failure));

  const observations = Object.freeze(page.observations.map(toTriageScanObservation));
  if (page.continuation === null) {
    return Object.freeze({
      kind: 'complete' as const,
      observations,
      evidence: page.health === null
        ? Object.freeze({ kind: 'walkFinished' as const })
        : toTriageScanEvidence(page.health),
    });
  }
  return Object.freeze({
    kind: 'page' as const,
    observations,
    // A page in flight is not a finished walk. Sentry orders this pass by a
    // mutating clock, so an in-progress page is honestly `moving`.
    evidence: page.health === null
      ? Object.freeze({ kind: 'moving' as const, reason: SENTRY_MOVING_SCAN_REASON })
      : toTriageScanEvidence(page.health),
    continuation: Object.freeze({ v: 1 as const, token: page.continuation }),
  });
}

/** One authoritative read of one local ref through one exact configured instance. */
export async function getSentrySourceEntry(
  input: unknown,
  context: PluginInvocationContext,
): Promise<TriageGetResultV1> {
  const parsed = TriageGetInputV1Schema.parse(input);
  const localRef: TriageSourceEntryLocalRefV1 = toTriageLocalRef({
    kindId: SENTRY_ENTRY_KIND_ID,
    collisionScope: parsed.localRef.collisionScope,
    entryId: parsed.localRef.entryId,
  });
  const unresolved = (failure: TriageSourceFailureV1): TriageGetResultV1 => Object.freeze({
    kind: 'unresolved' as const,
    localRef: Object.freeze({
      kindId: parsed.localRef.kindId,
      collisionScope: parsed.localRef.collisionScope,
      entryId: parsed.localRef.entryId,
    }),
    failure,
  });

  const routed = admitSentryEntryInvocation({
    localInstanceKey: parsed.instance.localInstanceKey,
    configurationToken: parsed.instance.configuration.token,
    localRef: parsed.localRef,
  });
  if (!routed.ok) return unresolved(routed.failure);

  const client = await createSentryApiClient(context, {
    account: parsed.instance.binding.account,
    deployment: routed.deployment,
    nowMs: () => Date.now(),
  });
  const requestUrl = buildSentryIssueUrl({
    instance: routed.instance,
    entryId: parsed.localRef.entryId,
  });
  const outcome = await client.request({ url: requestUrl, operation: 'issue' });

  const resolved = resolveSentryGetOutcome({
    requestedEntryId: parsed.localRef.entryId,
    configured: routed.instance,
    requestUrl,
    organizationSlug: null,
    nowMs: Date.now(),
    outcome,
  });

  switch (resolved.kind) {
    case 'present':
      return toTriagePresentObservation(resolved.snapshot);
    case 'merged':
      return Object.freeze({
        kind: 'merged' as const,
        localRef,
        successor: toTriageLocalRef(resolved.successor),
      });
    case 'unresolved':
      return unresolved(toTriageFailure(resolved.failure));
  }
}
