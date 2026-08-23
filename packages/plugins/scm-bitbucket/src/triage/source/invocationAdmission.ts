import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type { BitbucketTriageApiClient } from '../apiClient.js';
import { createBitbucketFailure } from '../failures.js';
import {
  isBitbucketEntryId,
  readBitbucketCollisionScopeRepositoryUuid,
} from '../identity.js';
import { decodeBitbucketConfiguration } from '../instance.js';
import {
  createAuthorizedBitbucketClient,
  type BitbucketSourceRuntime,
} from './authorization.js';
import {
  BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
  BITBUCKET_PULL_REQUEST_KIND_ID,
} from './descriptor.js';
import { toTriageSourceFailure } from './failures.js';

/**
 * The one admission rule every entry-scoped Bitbucket invocation passes.
 *
 * `scan` and `get` carry the published Triage roles and admit their own inputs; everything that
 * addresses ONE already-minted entry — the mounted detail planes and the pull-request mutations —
 * asks the same four questions, and asks them here rather than in each caller. Two copies of this
 * check would be two answers to "may this reference route through this configured workspace", and
 * the copy that drifted would be the one guarding a write.
 *
 * The repository UUID is read back out of the collision scope rather than taken from a routing
 * token: the scope is the value this source itself minted, and a reference keyed against another
 * workspace cannot address a repository here. The account is rematerialized on every invocation
 * and grants no standing authority.
 */

/** The provider-native triple a proven local ref addresses. */
export type BitbucketEntryRouteV1 = Readonly<{
  workspaceUuid: string;
  repositoryUuid: string;
  entryId: string;
}>;

export type BitbucketAdmittedInvocation =
  | Readonly<{ ok: true; route: BitbucketEntryRouteV1; client: BitbucketTriageApiClient }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

const KIND_NOT_DECLARED = createBitbucketFailure('unsupportedContract', 'kind-not-declared');
const BINDING_PURPOSE_MISMATCH = createBitbucketFailure(
  'unsupportedContract',
  'binding-purpose-mismatch',
);
const CONFIGURATION_UNDECODABLE = createBitbucketFailure(
  'unsupportedContract',
  'configuration-undecodable',
);
const CONFIGURATION_INSTANCE_MISMATCH = createBitbucketFailure(
  'unsupportedContract',
  'configuration-instance-mismatch',
);
const COLLISION_SCOPE_INVALID = createBitbucketFailure(
  'unsupportedContract',
  'collision-scope-invalid',
);
const ENTRY_ID_INVALID = createBitbucketFailure('unsupportedContract', 'entry-id-invalid');

/** The host services one bounded invocation reaches, bound to the signal that owns its lifetime. */
export function toBitbucketRuntime(
  context: PluginInvocationContext,
  signal: AbortSignal | undefined,
): BitbucketSourceRuntime {
  return {
    connectedAccounts: context.services.connectedAccounts,
    http: context.services.http,
    now: () => Date.now(),
    ...(signal === undefined ? {} : { signal }),
  };
}

export async function admitBitbucketEntryInvocation(
  input: Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    localRef: Readonly<{ kindId: string; entryId: string; collisionScope: string }>;
  }>,
  runtime: BitbucketSourceRuntime,
): Promise<BitbucketAdmittedInvocation> {
  if (input.localRef.kindId !== BITBUCKET_PULL_REQUEST_KIND_ID) {
    return { ok: false, failure: toTriageSourceFailure(KIND_NOT_DECLARED) };
  }
  if (input.instance.binding.purpose !== BITBUCKET_CONNECTED_ACCOUNT_PURPOSE) {
    return { ok: false, failure: toTriageSourceFailure(BINDING_PURPOSE_MISMATCH) };
  }

  const configuration = decodeBitbucketConfiguration(input.instance.configuration);
  if (configuration === null) {
    return { ok: false, failure: toTriageSourceFailure(CONFIGURATION_UNDECODABLE) };
  }
  if (input.instance.localInstanceKey !== configuration.workspaceUuid) {
    return { ok: false, failure: toTriageSourceFailure(CONFIGURATION_INSTANCE_MISMATCH) };
  }

  const repositoryUuid = readBitbucketCollisionScopeRepositoryUuid(input.localRef.collisionScope);
  if (repositoryUuid === null) {
    return { ok: false, failure: toTriageSourceFailure(COLLISION_SCOPE_INVALID) };
  }
  if (!isBitbucketEntryId(input.localRef.entryId)) {
    return { ok: false, failure: toTriageSourceFailure(ENTRY_ID_INVALID) };
  }

  const authorized = await createAuthorizedBitbucketClient(runtime, {
    purpose: input.instance.binding.purpose,
    account: input.instance.binding.account,
  });
  if (!authorized.ok) return { ok: false, failure: toTriageSourceFailure(authorized.failure) };

  return {
    ok: true,
    route: Object.freeze({
      workspaceUuid: configuration.workspaceUuid,
      repositoryUuid,
      entryId: input.localRef.entryId,
    }),
    client: authorized.client,
  };
}
