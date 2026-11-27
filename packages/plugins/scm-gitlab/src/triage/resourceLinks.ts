import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { TriageResolveResourceConnectedAccountInputV1Schema, type TriageResolveResourceResultV1 } from '@happier-dev/triage-protocol/v1';

import { readGitlabMergeRequestUrl } from '../pullRequests/route.js';
import { authorizeGitlabBoundAccount, resolveGitlabConfiguredInstance } from './configuredInstance.js';
import { buildGitlabItemUrl } from './detail/routes.js';
import { readGitlabProjectIdWithinOrigin } from './identity.js';
import { requestGitlabJson } from './http/gitlabClient.js';
import { createGitlabHttpFetcher, readGitlabConnectedAccounts } from './invocation.js';
import { decodeGitlabRow } from './mapping/gitlabEntry.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';
import { projectGitlabPresentObservation } from './sourceObservation.js';

export async function resolveGitlabTriageResource(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<TriageResolveResourceResultV1> {
  const parsed = TriageResolveResourceConnectedAccountInputV1Schema.parse(input);
  const configured = resolveGitlabConfiguredInstance(parsed.instance);
  if (configured.kind === 'failed') return { kind: 'unavailable', failure: projectGitlabSourceFailure(configured.failure) };
  const unsupported = { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'gitlab-resource-url-unsupported' } } as const;
  if (parsed.resource.kind !== 'pullRequest') return unsupported;
  const { origin } = configured;
  const route = readGitlabMergeRequestUrl(origin, parsed.resource.url);
  if (route === null) return unsupported;
  const authorized = await authorizeGitlabBoundAccount({
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    instance: configured.instance, origin, connectedAccounts: readGitlabConnectedAccounts(context), signal: context.signal,
  });
  if (authorized.kind === 'failed') return { kind: 'unavailable', failure: projectGitlabSourceFailure(authorized.failure) };
  const kindId = 'merge-request';
  const repositoryKey = route.repositoryPath.toLowerCase();
  const item = await requestGitlabJson({
    invocation: authorized.resolved.invocation,
    url: buildGitlabItemUrl({ origin, kindId, repositoryKey, iid: route.iid }),
    fetcher: createGitlabHttpFetcher(context), signal: context.signal, nowMs: context.invokedAtMs,
  });
  if (item.kind === 'failed') return { kind: 'unavailable', failure: projectGitlabSourceFailure(item.failure) };
  const decoded = decodeGitlabRow({ kindId, origin, row: item.response.body });
  if (decoded.kind !== 'mapped' || decoded.entry.identity.entryId !== route.iid
    || decoded.entry.locator.repositoryKey !== repositoryKey) return unsupported;

  const { selection } = configured.configuration;
  if (selection.kind === 'selected') {
    const id = readGitlabProjectIdWithinOrigin(decoded.entry.identity, origin);
    if (id === null || !selection.unitIds.includes(id)) return unsupported;
  }
  const { localRef, locator } = projectGitlabPresentObservation(decoded.entry);
  return { kind: 'resolved', localRef, locator };
}
