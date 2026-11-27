import { buildDeploymentPreviewEnvironmentQueryV1 } from '@happier-dev/plugin-sdk/protocol';
import { GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from './configuration.js';
import type { GithubRepositoryRouteV1 } from './locator.js';

/** The Action and its live UI observation select the same exact repository and PR ids. */
export function buildGithubPreviewEnvironmentQueryV1(serverId: string, route: GithubRepositoryRouteV1,
    pullRequestIds: readonly string[]) {
    return buildDeploymentPreviewEnvironmentQueryV1(serverId, { kind: 'github', deployment: GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
        repository: `${route.owner}/${route.name}` }, pullRequestIds);
}
