import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';

import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectRenderablePluginInlineSurfacePlacementsForRole } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

/**
 * Bind branch discovery to the admitted Session PR presentation. The plugin
 * owns explicit-link matching, status and attach; SCM never interprets those
 * facts or selects a first-party contributor by id.
 */
export function resolveScmPullRequestSurfaceBinding(input: Readonly<{
    projection: PluginUiProjectionModel | null;
    pullRequest?: ScmPullRequestSummary | null;
    origin?: 'createdHere';
    targetKind: 'session' | 'app';
    policyContext?: PluginUiPolicyEvaluationContext;
}>) {
    if (!input.projection) return null;
    const placements = selectRenderablePluginInlineSurfacePlacementsForRole(
        input.projection, 'scmPullRequest', input.policyContext,
    ).filter(placement => placement.binding.targetKind === input.targetKind);
    // Competing declarations cannot appoint an owner through sort order.
    if (placements.length !== 1) return null;
    return {
        placement: placements[0]!,
        inlineMount: { role: 'scmPullRequest', presentation: 'content' } as const,
        launchInput: { ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}), ...(input.origin ? { origin: input.origin } : {}) },
    };
}
