import type {
  TriageGetInputV1,
  TriageGetResultV1,
} from '@happier-dev/triage-protocol/v1';

import { createBitbucketFailure, type BitbucketTriageFailure } from '../failures.js';
import { readBitbucketCollisionScopeRepositoryUuid } from '../identity.js';
import { decodeBitbucketConfiguration } from '../instance.js';
import { getBitbucketPullRequest } from '../pullRequests.js';
import { getBitbucketViewer } from '../viewer.js';
import {
  createAuthorizedBitbucketClient,
  type BitbucketSourceRuntime,
} from './authorization.js';
import {
  BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
  BITBUCKET_PULL_REQUEST_KIND_ID,
} from './descriptor.js';
import { toTriageSourceFailure } from './failures.js';
import { toBitbucketPresentObservation } from './observations.js';

/**
 * Bitbucket Cloud V1 never concludes absence.
 *
 * Under one credential the API cannot distinguish a pull request that was removed from one this
 * caller cannot see, so repository readability is not a deletion proof. Every non-success — a `404`
 * included — is `unresolved`, and a declined or superseded pull request is `present` with its state.
 */
export async function getBitbucketSourceEntry(
  runtime: BitbucketSourceRuntime,
  input: TriageGetInputV1,
): Promise<TriageGetResultV1> {
  const unresolved = (failure: BitbucketTriageFailure): TriageGetResultV1 => ({
    kind: 'unresolved',
    localRef: input.localRef,
    failure: toTriageSourceFailure(failure),
  });

  if (input.localRef.kindId !== BITBUCKET_PULL_REQUEST_KIND_ID) {
    return unresolved(createBitbucketFailure('unsupportedContract', 'kind-not-declared'));
  }
  if (input.instance.binding.purpose !== BITBUCKET_CONNECTED_ACCOUNT_PURPOSE) {
    return unresolved(createBitbucketFailure('unsupportedContract', 'binding-purpose-mismatch'));
  }

  const configuration = decodeBitbucketConfiguration(input.instance.configuration);
  if (configuration === null) {
    return unresolved(createBitbucketFailure('unsupportedContract', 'configuration-undecodable'));
  }
  if (input.instance.localInstanceKey !== configuration.workspaceUuid) {
    return unresolved(
      createBitbucketFailure('unsupportedContract', 'configuration-instance-mismatch'),
    );
  }

  const repositoryUuid = readBitbucketCollisionScopeRepositoryUuid(input.localRef.collisionScope);
  if (repositoryUuid === null) {
    return unresolved(createBitbucketFailure('unsupportedContract', 'collision-scope-invalid'));
  }

  const authorized = await createAuthorizedBitbucketClient(runtime, {
    purpose: input.instance.binding.purpose,
    account: input.instance.binding.account,
  });
  if (!authorized.ok) return unresolved(authorized.failure);

  // The viewer is read first: without the credential's provider identity the present arm could only
  // claim an empty involvement set, and "not involved" is a different statement from "unknown".
  const viewer = await getBitbucketViewer({
    client: authorized.client,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (!viewer.ok) return unresolved(viewer.failure);

  const outcome = await getBitbucketPullRequest({
    client: authorized.client,
    workspaceUuid: configuration.workspaceUuid,
    repositoryUuid,
    entryId: input.localRef.entryId,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (outcome.kind === 'unresolved') return unresolved(outcome.failure);

  const observation = toBitbucketPresentObservation(outcome.entry, {
    viewerAccountUuid: viewer.viewer.accountUuid,
  });
  // The authoritative result addresses exactly the requested ref; a different ref is invalid rather
  // than a redirect the caller should follow.
  if (
    observation.localRef.kindId !== input.localRef.kindId
    || observation.localRef.collisionScope !== input.localRef.collisionScope
    || observation.localRef.entryId !== input.localRef.entryId
  ) {
    return unresolved(createBitbucketFailure('unknown', 'route-body-mismatch'));
  }
  return observation;
}
