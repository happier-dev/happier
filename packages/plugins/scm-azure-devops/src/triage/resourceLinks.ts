import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { TriageResolveResourceConnectedAccountInputV1Schema, type TriageResolveResourceResultV1 } from '@happier-dev/triage-protocol/v1';

import { readAzurePullRequestUrl } from '../parsing/azureDevopsCoordinates.js';
import { resolveAzureConfiguredOrigin } from './configuration.js';
import { AZURE_DEVOPS_TRIAGE_KIND_ID, AZURE_DEVOPS_TRIAGE_PURPOSE } from './descriptor.js';
import { buildAzureCollisionScope, buildAzureEntryId } from './identity.js';
import { toAzureTransport } from './invocation.js';
import { projectAzurePullRequestLocator } from './observation.js';
import { authorizeClient, rereadAzurePullRequest } from './operations.js';
import { buildAzureRepositoryKey } from './origin.js';

export async function resolveAzureTriageResource(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<TriageResolveResourceResultV1> {
  const { instance, resource } = TriageResolveResourceConnectedAccountInputV1Schema.parse(input);
  const unsupported = { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'azure-devops/resource-url-unsupported' } } as const;
  if (resource.kind !== 'pullRequest' || instance.binding.purpose !== AZURE_DEVOPS_TRIAGE_PURPOSE) return unsupported;
  const origin = resolveAzureConfiguredOrigin(instance.configuration);
  if (origin === null) return unsupported;
  const address = readAzurePullRequestUrl(origin.baseUrl, resource.url);
  if (address === null) return unsupported;
  const routingToken = buildAzureRepositoryKey({
    ...origin, projectName: address.project, repositoryName: address.repository,
  });
  const authorized = await authorizeClient({
    instance, origin, signal: context.signal,
    services: { connectedAccounts: context.services.connectedAccounts,
      transport: toAzureTransport(context.services.http, context.signal), now: () => Date.now() },
  });
  if (!authorized.ok) return { kind: 'unavailable', failure: authorized.failure };
  const result = await rereadAzurePullRequest({
    client: authorized.client, origin, signal: context.signal, localRef: null,
    route: { kind: 'locator', project: address.project, repositoryId: address.repository,
      pullRequestId: address.pullRequestId, routingToken },
  });
  if (result.kind === 'unavailable') return { kind: 'unavailable', failure: result.failure };
  if (result.kind === 'malformed') return unsupported;
  const collisionScope = buildAzureCollisionScope({ origin, repositoryId: result.row.repositoryId });
  const entryId = buildAzureEntryId(result.row.pullRequestId);
  if (entryId === null || collisionScope === null) return unsupported;
  return {
    kind: 'resolved', localRef: { kindId: AZURE_DEVOPS_TRIAGE_KIND_ID, collisionScope, entryId },
    locator: projectAzurePullRequestLocator(routingToken, result.scope.repository.webUrl, entryId),
  };
}
