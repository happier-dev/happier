import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { createGithubNativeApiClient, type GithubApiClientV1 } from '../observations/githubApiClient.js';
import { classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { readGithubRepositoryDefaultBranchV1 } from '../repositoryProvisioning/githubRepositoryMapping.js';
import { githubRecord } from './mapping.js';
import { GithubWorkflowShaV1Schema } from './identity.js';
import { githubCiRepositoryUrl, GithubCiReadError, requestGithubCiJson } from './reads.js';
import { resolveGithubWorkflowRefV1 } from './workflowInputs.js';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID, GithubOverviewTargetInputV1Schema, GithubOverviewTargetResultV1Schema } from './overviewContracts.js';
import { GITHUB_ACCOUNT_EXECUTION } from '../triage/readActions.js';

/** Repository metadata names the default ref; the existing ref owner resolves its current commit. */
export async function readGithubOverviewTargetV1(client: GithubApiClientV1, repository: ScmHostingRepositoryIdentityV1, ref?: string) {
  const response = await requestGithubCiJson(client, githubCiRepositoryUrl(repository));
  if (response.kind !== 'value') throw new RangeError('Default branch is unavailable');
  const raw = githubRecord(response.value);
  if (typeof raw.full_name !== 'string' || raw.full_name.toLowerCase() !== repository.repository.toLowerCase()) {
    throw new RangeError('GitHub repository mismatch');
  }
  const branch = ref ?? readGithubRepositoryDefaultBranchV1(raw);
  if (!branch) throw new RangeError('Default branch is unavailable');
  if (branch.startsWith('refs/heads/')) {
    const name = branch.slice('refs/heads/'.length);
    if (!name) throw new RangeError('Branch name is unavailable');
    const response = await requestGithubCiJson(client, githubCiRepositoryUrl(repository, 'branches', name));
    if (response.kind !== 'value') throw new RangeError('Branch head is unavailable');
    const raw = githubRecord(response.value);
    const sha = GithubWorkflowShaV1Schema.safeParse(githubRecord(raw.commit).sha);
    if (raw.name !== name || !sha.success) throw new RangeError('Invalid branch identity');
    return { repository, branch, headSha: sha.data };
  }
  const headSha = await resolveGithubWorkflowRefV1(client, repository, branch);
  return { repository, branch, headSha };
}

export const GITHUB_OVERVIEW_TARGET_ACTIONS_V1 = {
  [GITHUB_OVERVIEW_TARGET_ACTION_ID]: {
    title: 'Read GitHub branch HEAD',
    description: 'Resolves the requested repository branch, or its default branch, to an exact current GitHub commit.',
    surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'] as const,
    placementBindings: [], dangerLevel: 'safe' as const, readOnly: true as const,
    execution: GITHUB_ACCOUNT_EXECUTION,
    inputSchema: GithubOverviewTargetInputV1Schema.jsonSchema, resultSchema: GithubOverviewTargetResultV1Schema.jsonSchema,
    hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
    async run(raw: unknown, context: GithubHttpInvocationContextV1) {
      const input = GithubOverviewTargetInputV1Schema.parse(raw);
      try { return projectNativeJsonValueForTransport({ kind: 'value' as const, value: await readGithubOverviewTargetV1(await createGithubNativeApiClient(context), input.repository, input.ref) }); }
      catch (error) {
        // Keep host-owned remedies on the existing Action failure envelope.
        if (isPluginError(error)) throw error;
        return projectNativeJsonValueForTransport({ kind: 'unavailable' as const, failure: error instanceof GithubCiReadError ? error.failure
        : error instanceof RangeError ? { class: 'unsupportedContract' as const, code: 'github_overview_target_unavailable' }
          : classifyGithubTransportFailure(error) }); }
    },
  },
};
