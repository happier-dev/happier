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
  const kindId = readGitlabTriageKindId(input.localRef.kindId);
  if (kindId === null || !input.admissibleKinds.includes(kindId)) {
    return Object.freeze({ ok: false as const, failure: GITLAB_KIND_UNSUPPORTED_FAILURE });
  }

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

  const projectId = readGitlabScopeProjectId(input.localRef.collisionScope, origin);
  if (projectId === null) {
    return Object.freeze({ ok: false as const, failure: GITLAB_SCOPE_OUTSIDE_BINDING_FAILURE });
  }
  if (!/^[1-9][0-9]*$/u.test(input.localRef.entryId)) {
    return Object.freeze({ ok: false as const, failure: GITLAB_ENTRY_ID_UNUSABLE_FAILURE });
  }

  return Object.freeze({
    ok: true as const,
    route: Object.freeze({ origin, projectId, iid: input.localRef.entryId, kindId }),
    dependencies: Object.freeze({
      invocation,
      fetcher: createGitlabHttpFetcher(context),
      signal: context.signal,
      nowMs: Date.now(),
    }),
  });
}
