import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { classifyGithubTransportFailure } from '../../observations/githubResponseFailure.js';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID, GithubOverviewTargetResultV1Schema } from '../../actions/overviewContracts.js';
import { projectGithubOverviewCiContextV1, type GithubCiSurfaceContextV1 } from './ciContext.js';

export type GithubOverviewCiContextResultV1 = Readonly<{
  context: GithubCiSurfaceContextV1;
  failure: TriageSourceFailureV1 | null;
}>;

/** Resolve Overview from its native repository default ref, never the caller's Session or a CI run. */
export async function readGithubOverviewCiContextV1(host: Pick<PluginUiHostApi, 'executeAction'>,
  repository: ScmHostingRepositoryIdentityV1, options?: Readonly<{ signal?: AbortSignal }>, previous: GithubCiSurfaceContextV1 | null = null): Promise<GithubOverviewCiContextResultV1> {
  const unknown = (failure: TriageSourceFailureV1 | null = null): GithubOverviewCiContextResultV1 => ({
    context: projectGithubOverviewCiContextV1(previous, { repository: null, defaultBranch: null, headSha: null }), failure,
  });
  if (options?.signal?.aborted) return unknown();
  try {
    const result = await host.executeAction({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_OVERVIEW_TARGET_ACTION_ID }, { repository }, options);
    const target = GithubOverviewTargetResultV1Schema.safeParse(result);
    if (options?.signal?.aborted || !target.success) return unknown();
    if (target.data.kind === 'unavailable') return unknown(target.data.failure);
    if (!sameScmHostingRepositoryIdentity(repository, target.data.value.repository)) return unknown();
    return { context: projectGithubOverviewCiContextV1(previous, {
      repository: target.data.value.repository, defaultBranch: target.data.value.branch, headSha: target.data.value.headSha,
    }), failure: null };
  } catch (error) {
    // Retiring the mounted host has no provider diagnostic to display.
    return unknown(isPluginError(error) && error.code !== 'ui_host_unavailable' ? classifyGithubTransportFailure(error) : null);
  }
}
