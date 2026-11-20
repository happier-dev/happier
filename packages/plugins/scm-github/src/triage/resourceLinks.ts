import type { GithubApiClientV1 } from '../observations/githubApiClient.js';
import { githubSelectionIncludes } from './configuration.js';
import { buildGithubEntryLocalRef } from './identity.js';
import { buildGithubEntryLocator, parseGithubResourceUrl } from './locator.js';
import { createGithubRepositoryReader } from './repositories.js';
import { toTriageFailure, toTriageLocator } from './mapping/protocol.js';
import type { GithubTriageInvocationContext } from './invocation.js';
import { TriageSourceCredentialInputsV1, type TriageResolveResourceResultV1 } from '@happier-dev/triage-protocol/v1';
import { resolveGithubTriageInstance, openGithubTriageClient } from './operations.js';

/** The admitted source Action keeps credential placement and configured scope intact. */
export async function resolveGithubTriageResource(input: unknown, context: GithubTriageInvocationContext): Promise<TriageResolveResourceResultV1> {
  const parsed = TriageSourceCredentialInputsV1.resolveResource.safeParse(input);
  const unsupported = { kind: 'unavailable' as const, failure: { class: 'unsupportedContract' as const, code: 'github_resource_url_unsupported' } };
  if (!parsed.success) return unsupported;
  const resolved = resolveGithubTriageInstance(parsed.data.instance);
  if (!resolved.ok) return { kind: 'unavailable', failure: resolved.failure };
  const route = parseGithubResourceUrl(parsed.data.resource);
  if (route === null || route.kindId === null) return unsupported;
  if (!githubSelectionIncludes(resolved.configuration, `${route.owner}/${route.name}`)) return unsupported;
  const opened = await openGithubTriageClient(parsed.data.instance, context);
  if (!opened.ok) return { kind: 'unavailable', failure: opened.failure };
  return resolveGithubResourceEntry(parsed.data.resource, { client: opened.client, now: () => context.invokedAtMs });
}

/** Resolve one URL with the same credential and repository identity owner as exact get. */
export async function resolveGithubResourceEntry(resource: Readonly<{ kind: string; url: string }>,
  dependencies: Readonly<{ client: GithubApiClientV1; now: () => number }>) {
  const route = parseGithubResourceUrl(resource);
  if (route === null || route.kindId === null) return { kind: 'unavailable' as const,
    failure: { class: 'unsupportedContract' as const, code: 'github_resource_url_unsupported' } };
  const repository = await createGithubRepositoryReader(dependencies).read(route);
  if (repository.kind !== 'readable') return { kind: 'unavailable' as const, failure: toTriageFailure(repository.failure) };
  const localRef = buildGithubEntryLocalRef({ kindId: route.kindId, repositoryId: repository.repositoryId, nativeItemId: route.number });
  const locator = buildGithubEntryLocator({ ...route, entryNumber: route.number, webUrl: resource.url });
  if (localRef === null || locator === null) return { kind: 'unavailable' as const,
    failure: { class: 'unknown' as const, code: 'github_resource_identity_unavailable' } };
  return { kind: 'resolved' as const, localRef, locator: toTriageLocator(locator) };
}
