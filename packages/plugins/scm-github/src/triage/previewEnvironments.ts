import { isPluginActionApprovalRequestCreated, type DeploymentsActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { GithubTriageInvocationContext } from './invocation.js';
import type { GithubRepositoryRouteV1 } from './locator.js';
import { buildGithubPreviewEnvironmentQueryV1 } from './previewQuery.js';
import { selectGithubCurrentPreviewEnvironmentsV1 } from './previewProjection.js';

type Environment = Extract<DeploymentsActionResultById['deployments.environments.list'], { ok: true }>['items'][number];

/** Public reads and publication consume the same current child for each template target.
 * The Home orders retained children; an active child supersedes its older tombstone. */
export async function readGithubPreviewEnvironments(serverId: string, route: GithubRepositoryRouteV1, pullRequestId: string,
  context: GithubTriageInvocationContext): Promise<Readonly<{ ok: true; items: readonly Environment[] }> | Readonly<{ ok: false; error: string }>> {
  const items: Environment[] = [];
  let cursor: string | undefined;
  do {
    const page = await context.services.actions.execute('deployments.environments.list', {
      ...buildGithubPreviewEnvironmentQueryV1(serverId, route, [pullRequestId]), ...(cursor ? { cursor } : {}),
    }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(page)) return { ok: false, error: 'deployment_unavailable' };
    if (!page.ok) return page;
    if (page.coverage === 'partial') return { ok: false, error: 'deployment_unavailable' };
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { ok: true, items: selectGithubCurrentPreviewEnvironmentsV1(items) };
}
