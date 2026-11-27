import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { TriageResolveResourceConnectedAccountInputV1Schema, type TriageResolveResourceResultV1 } from '@happier-dev/triage-protocol/v1';

import { readBitbucketPullRequestUrl } from '../../parsing/bitbucketCoordinates.js';
import { decodeBitbucketConfiguration } from '../instance.js';
import { getBitbucketPullRequest } from '../pullRequests.js';
import { createAuthorizedBitbucketClient } from './authorization.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import { toTriageSourceFailure } from './failures.js';
import { toBitbucketRuntime } from './invocationAdmission.js';
import { buildBitbucketEntryLocator, buildBitbucketLocalRef } from './observations.js';

export async function resolveBitbucketTriageResource(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<TriageResolveResourceResultV1> {
  const { instance, resource } = TriageResolveResourceConnectedAccountInputV1Schema.parse(input);
  const unsupported = { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'bitbucket-resource-url-unsupported' } } as const;
  if (resource.kind !== 'pullRequest') return unsupported;
  const route = readBitbucketPullRequestUrl(resource.url);
  if (route === null) return unsupported;
  const configuration = decodeBitbucketConfiguration(instance.configuration);
  if (configuration === null || instance.localInstanceKey !== configuration.workspaceUuid
    || instance.binding.purpose !== BITBUCKET_CONNECTED_ACCOUNT_PURPOSE) return unsupported;
  const authorized = await createAuthorizedBitbucketClient(toBitbucketRuntime(context), instance.binding);
  if (!authorized.ok) return { kind: 'unavailable', failure: toTriageSourceFailure(authorized.failure) };
  const result = await getBitbucketPullRequest({
    client: authorized.client, workspaceUuid: configuration.workspaceUuid,
    repositorySlug: route.repositorySlug, expectedRepositoryKey: route.repositoryKey, entryId: route.entryId,
    signal: context.signal,
  });
  return result.kind === 'unresolved' ? { kind: 'unavailable', failure: toTriageSourceFailure(result.failure) }
    : { kind: 'resolved', localRef: buildBitbucketLocalRef(result.entry), locator: buildBitbucketEntryLocator(result.entry) };
}
