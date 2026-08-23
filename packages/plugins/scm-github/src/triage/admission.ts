import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type { GithubApiClientV1 } from '../observations/githubApiClient.js';

import { readGithubTriageKindId } from './contribution.js';
import { parseGithubRoutingToken, type GithubRepositoryRouteV1 } from './locator.js';
import { openGithubTriageClient, resolveGithubTriageInstance } from './operations.js';
import type { GithubTriageEntryLocalRefV1, GithubTriageKindIdV1 } from './types.js';

/**
 * The one admission every entry-scoped GitHub invocation passes through.
 *
 * A detail read and a pull-request write ask the host exactly the same four
 * questions — is this a kind I declare, is this configured instance bound to my
 * purpose, can I parse the route the target observed for THIS entry, and can I
 * materialize that exact account right now — so they ask them in one place. A
 * second, similar-but-different admission is how one caller starts trusting a
 * cached permission that the other rereads.
 *
 * The route comes only from current source evidence: `routingToken` is the
 * newest locator the target holds, it is source-private, and it grants no
 * authority — the account is rematerialized from the configured instance on
 * every invocation. A token this source cannot parse yields a stated failure and
 * no outbound call; a path is never guessed from identity, display text or a git
 * remote.
 */

export const GITHUB_LOCATOR_UNUSABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_locator_unusable',
});

export const GITHUB_KIND_UNSUPPORTED_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_kind_unsupported',
});

export type GithubAdmittedInvocationV1 =
  | Readonly<{
    ok: true;
    route: GithubRepositoryRouteV1;
    /** The native item number, as it appears in the local ref. */
    entryNumber: string;
    localRef: GithubTriageEntryLocalRefV1;
    kindId: GithubTriageKindIdV1;
    client: GithubApiClientV1;
  }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

export async function admitGithubEntryInvocation(
  input: Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    localRef: Readonly<{ kindId: string; collisionScope: string; entryId: string }>;
    routingToken: string;
    /** The kinds this caller can answer for at all. */
    admissibleKinds: readonly GithubTriageKindIdV1[];
  }>,
  context: PluginInvocationContext,
): Promise<GithubAdmittedInvocationV1> {
  const kindId = readGithubTriageKindId(input.localRef.kindId);
  if (kindId === null || !input.admissibleKinds.includes(kindId)) {
    return Object.freeze({ ok: false as const, failure: GITHUB_KIND_UNSUPPORTED_FAILURE });
  }

  const resolved = resolveGithubTriageInstance(input.instance);
  if (!resolved.ok) return Object.freeze({ ok: false as const, failure: resolved.failure });

  const route = parseGithubRoutingToken(input.routingToken);
  if (route === null) {
    return Object.freeze({ ok: false as const, failure: GITHUB_LOCATOR_UNUSABLE_FAILURE });
  }

  const opened = await openGithubTriageClient(input.instance, context);
  if (!opened.ok) return Object.freeze({ ok: false as const, failure: opened.failure });

  return Object.freeze({
    ok: true as const,
    route,
    entryNumber: input.localRef.entryId,
    localRef: Object.freeze({
      kindId,
      collisionScope: input.localRef.collisionScope,
      entryId: input.localRef.entryId,
    }),
    kindId,
    client: opened.client,
  });
}
