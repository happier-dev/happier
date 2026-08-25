/**
 * The one rule that admits an invocation carrying a configured deployment and a
 * canonical entry reference.
 *
 * Every source-native Action that addresses one merge request or one issue —
 * the six detail planes and every mutation — crosses this function. It is a
 * single owner on purpose: a mutation that admitted its route by a slightly
 * different rule than the read the user acted on could write to a project the
 * reference was never keyed against.
 *
 * The project id is read back out of the collision scope this source itself
 * minted and re-validated per origin, so a reference keyed against another
 * deployment cannot address a project that happens to carry the same number
 * here. The account is rematerialized on every invocation and grants no standing
 * authority.
 *
 * The Action entry points install the source-owned deadline before calling this
 * admission rule and dispose it after the whole operation settles. That keeps
 * account materialization and every later request under one signal while still
 * letting normal completion clear the timer.
 *
 * `scan`, `get` and `listInstances` deliberately do NOT pass through here.
 * §5.2 gives those three to Triage, and a second deadline underneath a
 * target-owned one would be a second owner of when that invocation gives up.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { authorizeGitlabConfiguredInstance } from './configuredInstance.js';
import { readGitlabTriageKindId } from './contribution.js';
import type { GitlabDetailReadDependenciesV1 } from './detail/reads.js';
import type { GitlabDetailRouteInputV1 } from './detail/routes.js';
import { readGitlabScopeProjectId } from './identity.js';
import { createGitlabHttpFetcher, readGitlabConnectedAccounts } from './invocation.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';
import type { GitlabKindId } from './types.js';

export const GITLAB_SCOPE_OUTSIDE_BINDING_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'scope-outside-binding',
  detail: 'The requested entry was not keyed against this configured deployment.',
});

export const GITLAB_ENTRY_ID_UNUSABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'unusable-entry-id',
  detail: 'A GitLab entry id is a positive project-internal id.',
});

export const GITLAB_KIND_UNSUPPORTED_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-kind-unsupported',
});

export type GitlabAdmittedItemIdentity = Readonly<{
  kindId: GitlabKindId;
  iid: string;
  collisionScope: string;
}>;

/**
 * Pure admission of the source-owned parts of an entry reference.
 *
 * `get`, detail reads and mutations all call this function. Keeping the check
 * independent of account materialization is intentional: a malformed ref is
 * refused before credentials are requested, and every caller returns the same
 * failure for the same bytes.
 */
export function admitGitlabItemIdentity(input: Readonly<{
  localRef: Readonly<{ kindId: string; entryId: string; collisionScope: string }>;
  admissibleKinds: readonly GitlabKindId[];
}>): Readonly<{ ok: true; identity: GitlabAdmittedItemIdentity }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }> {
  const kindId = readGitlabTriageKindId(input.localRef.kindId);
  if (kindId === null || !input.admissibleKinds.includes(kindId)) {
    return Object.freeze({ ok: false as const, failure: GITLAB_KIND_UNSUPPORTED_FAILURE });
  }
  if (!/^[1-9][0-9]*$/u.test(input.localRef.entryId)) {
    return Object.freeze({ ok: false as const, failure: GITLAB_ENTRY_ID_UNUSABLE_FAILURE });
  }
  return Object.freeze({
    ok: true as const,
    identity: Object.freeze({
      kindId,
      iid: input.localRef.entryId,
      collisionScope: input.localRef.collisionScope,
    }),
  });
}

/** Resolves an admitted identity inside the exact authorized deployment. */
export function resolveGitlabItemRoute(
  identity: GitlabAdmittedItemIdentity,
  origin: GitlabDetailRouteInputV1['origin'],
): Readonly<{ ok: true; route: GitlabDetailRouteInputV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }> {
  const projectId = readGitlabScopeProjectId(identity.collisionScope, origin);
  if (projectId === null) {
    return Object.freeze({ ok: false as const, failure: GITLAB_SCOPE_OUTSIDE_BINDING_FAILURE });
  }
  return Object.freeze({
    ok: true as const,
    route: Object.freeze({ origin, projectId, iid: identity.iid, kindId: identity.kindId }),
  });
}

/**
 * How long one mounted GitLab detail plane may wait on its provider, end to end.
 *
 * A plane's reads are several requests behind one panel — a discussions page and its notes, a
 * pipeline rollup and its jobs — so the bound covers the invocation rather than each request. It
 * is generous relative to a healthy GitLab.com read and short relative to a person's patience:
 * past it the honest answer is that this panel could not be filled, which the surface can show
 * and retry, rather than a spinner that outlives the reader's attention.
 */
export const GITLAB_MOUNTED_DETAIL_DEADLINE_MS = 20_000;

/**
 * How long one exact GitLab mutation may take, end to end.
 *
 * It covers the currentness preflight, the write itself and the confirming read together, because
 * those three are one press of one button and no part of them may be waited on separately. It is
 * longer than a detail read's because it contains three provider round trips, and because a
 * mutation that times out is settled by its own confirming read rather than by a retry.
 */
export const GITLAB_MUTATION_DEADLINE_MS = 45_000;

export type GitlabAdmittedInvocation =
  | Readonly<{
    ok: true;
    route: GitlabDetailRouteInputV1;
    dependencies: GitlabDetailReadDependenciesV1;
  }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

export async function admitGitlabItemInvocation(
  input: Readonly<{
    instance: Parameters<typeof authorizeGitlabConfiguredInstance>[0]['instance'];
    localRef: Readonly<{ kindId: string; entryId: string; collisionScope: string }>;
    /** The kinds this caller can answer for at all. */
    admissibleKinds: readonly GitlabKindId[];
  }>,
  context: PluginInvocationContext,
): Promise<GitlabAdmittedInvocation> {
  const identity = admitGitlabItemIdentity(input);
  if (!identity.ok) return identity;

  const authorized = await authorizeGitlabConfiguredInstance({
    instance: input.instance,
    connectedAccounts: readGitlabConnectedAccounts(context),
    signal: context.signal,
  });
  if (authorized.kind === 'failed') {
    return Object.freeze({
      ok: false as const,
      failure: projectGitlabSourceFailure(authorized.failure),
    });
  }
  const { origin, invocation } = authorized.resolved;

  const routed = resolveGitlabItemRoute(identity.identity, origin);
  if (!routed.ok) return routed;

  return Object.freeze({
    ok: true as const,
    route: routed.route,
    dependencies: Object.freeze({
      invocation,
      fetcher: createGitlabHttpFetcher(context),
      signal: context.signal,
      nowMs: Date.now(),
    }),
  });
}
