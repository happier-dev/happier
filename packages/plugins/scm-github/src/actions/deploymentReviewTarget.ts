import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createGithubNativeApiClient } from '../observations/githubApiClient.js';
import { classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { createGithubRepositorySourceConfig, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { buildGithubApiUrl } from '../triage/locator.js';
import { GithubCiReadError, requestGithubCiJson } from './reads.js';
import { decodeGithubDeploymentReviewLocationV1, GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID,
  GithubDeploymentReviewTargetInputV1Schema, GithubDeploymentReviewTargetResultV1Schema } from './deploymentReviewProtocol.js';

/** Resolve display routing using the same admitted native credential as foreground CI reads.
 * The locator neither selects a credential nor authorizes a review or a monitoring source. */
export const GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTIONS_V1 = {
  [GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID]: {
    title: 'Read deployment review target',
    description: 'Resolves the exact repository in a deployment review locator without selecting an account or monitoring Machine.',
    surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'] as const,
    placementBindings: [], dangerLevel: 'safe' as const, readOnly: true as const,
    inputSchema: GithubDeploymentReviewTargetInputV1Schema.jsonSchema,
    resultSchema: GithubDeploymentReviewTargetResultV1Schema.jsonSchema,
    hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
    async run(raw: unknown, context: GithubHttpInvocationContextV1) {
      context.signal.throwIfAborted();
      const input = GithubDeploymentReviewTargetInputV1Schema.parse(raw);
      try {
        const location = decodeGithubDeploymentReviewLocationV1(input.location);
        if (!location) throw new RangeError('Invalid deployment review locator');
        const client = await createGithubNativeApiClient(context);
        const response = await requestGithubCiJson(client, buildGithubApiUrl(['repositories', location.repositoryId]));
        context.signal.throwIfAborted();
        if (response.kind !== 'value') throw new RangeError('Repository identity is unavailable');
        const identity = createGithubRepositorySourceConfig(response.value);
        if (identity.repositoryId !== location.repositoryId) throw new RangeError('Repository identity mismatch');
        const repository = normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: 'https://github.com', repository: identity.nameWithOwner });
        if (!repository) throw new RangeError('Repository identity is invalid');
        return projectNativeJsonValueForTransport(GithubDeploymentReviewTargetResultV1Schema.parse({ kind: 'ready', repository, location }));
      } catch (error) {
        context.signal.throwIfAborted();
        return projectNativeJsonValueForTransport(GithubDeploymentReviewTargetResultV1Schema.parse({ kind: 'unavailable', failure:
          error instanceof GithubCiReadError ? error.failure
            : error instanceof RangeError ? { class: 'unsupportedContract', code: 'github_deployment_target_unavailable' }
              : classifyGithubTransportFailure(error) }));
      }
    },
  },
};
