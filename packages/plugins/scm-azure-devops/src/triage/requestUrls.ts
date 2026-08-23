import { AZURE_DEVOPS_API_VERSIONS } from './apiVersions.js';
import type { AzureDevOpsOrigin, AzureDevOpsRoute } from './types.js';

/**
 * Path segment constants. Route paths exist only in this module, and the only builder that
 * can produce a URL from them always appends the resource's pinned `api-version` — so a
 * request whose contract is chosen by the server is not expressible.
 */
const API_ROOT_SEGMENT = '_apis';
const GIT_AREA_SEGMENT = 'git';
const REPOSITORIES_SEGMENT = 'repositories';
const PULL_REQUESTS_SEGMENT = 'pullrequests';
const API_VERSION_PARAMETER = 'api-version';

export function buildAzureDevOpsRequestUrl(
  origin: AzureDevOpsOrigin,
  route: AzureDevOpsRoute,
  query?: Readonly<Record<string, string | number | undefined>>,
): string {
  const path = routeSegments(route).map((segment) => encodeURIComponent(segment)).join('/');
  const parameters: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    parameters.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  parameters.push(`${API_VERSION_PARAMETER}=${encodeURIComponent(AZURE_DEVOPS_API_VERSIONS[route.resource])}`);
  return `${origin.baseUrl}/${path}?${parameters.join('&')}`;
}

function routeSegments(route: AzureDevOpsRoute): readonly string[] {
  switch (route.resource) {
    case 'connectionData':
      return [API_ROOT_SEGMENT, 'connectionData'];
    case 'projects':
      return [API_ROOT_SEGMENT, 'projects'];
    case 'repositories':
      return [route.project, API_ROOT_SEGMENT, GIT_AREA_SEGMENT, REPOSITORIES_SEGMENT];
    case 'pullRequests':
      return [
        route.project,
        API_ROOT_SEGMENT,
        GIT_AREA_SEGMENT,
        REPOSITORIES_SEGMENT,
        route.repositoryId,
        PULL_REQUESTS_SEGMENT,
      ];
    case 'pullRequest':
      return [
        ...(route.project === undefined ? [] : [route.project]),
        API_ROOT_SEGMENT,
        GIT_AREA_SEGMENT,
        REPOSITORIES_SEGMENT,
        route.repositoryId,
        PULL_REQUESTS_SEGMENT,
        String(route.pullRequestId),
      ];
    case 'iterations':
      return [...pullRequestSubResource(route), 'iterations'];
    case 'iterationChanges':
      return [
        ...pullRequestSubResource(route),
        'iterations',
        // A real 1-based iteration. `0` is the `compareTo` baseline and never a path id.
        String(route.iterationId),
        'changes',
      ];
    case 'commits':
      return [...pullRequestSubResource(route), 'commits'];
    case 'threads':
      return [
        ...pullRequestSubResource(route),
        'threads',
        ...(route.threadId === undefined ? [] : [String(route.threadId)]),
      ];
    case 'reviewers':
      return [...pullRequestSubResource(route), 'reviewers'];
    case 'statuses':
      return [...pullRequestSubResource(route), 'statuses'];
    case 'policyEvaluations':
      // Project-scoped, not Git-scoped: Azure addresses policy evaluations under the
      // project and selects the item through an `artifactId` query parameter.
      return [route.project, API_ROOT_SEGMENT, 'policy', 'evaluations'];
  }
}

/**
 * The Git-area path every pull-request sub-resource hangs off.
 *
 * `pullRequests` is spelled with its capital `R` here on purpose: the sub-resource routes
 * Azure documents use that casing, and it is a different path from the collection route
 * above. The segments are encoded by the one builder, so the casing survives verbatim.
 */
function pullRequestSubResource(
  route: Readonly<{ repositoryId: string; pullRequestId: number }>,
): readonly string[] {
  return [
    API_ROOT_SEGMENT,
    GIT_AREA_SEGMENT,
    REPOSITORIES_SEGMENT,
    route.repositoryId,
    'pullRequests',
    String(route.pullRequestId),
  ];
}
