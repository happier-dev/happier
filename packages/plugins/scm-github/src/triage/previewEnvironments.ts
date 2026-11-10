import { isPluginActionApprovalRequestCreated, type DeploymentsActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { GithubTriageInvocationContext } from './invocation.js';
import type { GithubRepositoryRouteV1 } from './locator.js';
import { buildGithubPreviewEnvironmentQueryV1 } from './previewQuery.js';

type Environment = Extract<DeploymentsActionResultById['deployments.environments.list'], { ok: true }>['items'][number];

/** Public reads and publication consume the same current child for each template target.
 * The Home orders retained children; an active child supersedes its older tombstone. */
export async function readGithubPreviewEnvironments(serverId: string, route: GithubRepositoryRouteV1, pullRequestId: string,
  context: GithubTriageInvocationContext): Promise<Readonly<{ ok: true; items: readonly Environment[] }> | Readonly<{ ok: false; error: string }>> {
  const items: Environment[] = [];
  let cursor: string | undefined;
  do {
    const page = await context.services.actions.execute('deployments.environments.list', {
      ...buildGithubPreviewEnvironmentQueryV1(serverId, route, pullRequestId), ...(cursor ? { cursor } : {}),
    }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(page)) return { ok: false, error: 'deployment_unavailable' };
    if (!page.ok) return page;
    if (page.coverage === 'partial') return { ok: false, error: 'deployment_unavailable' };
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const current = new Map<string, Map<string, Environment>>();
  for (const item of items) {
    if (!item.previewTemplateEnvironmentId || !item.previewTargetLinkId) continue;
    let targets = current.get(item.previewTemplateEnvironmentId);
    if (!targets) { targets = new Map(); current.set(item.previewTemplateEnvironmentId, targets); }
    const previous = targets.get(item.previewTargetLinkId);
    if (!previous || previous.deletedAtMs !== undefined && item.deletedAtMs === undefined) targets.set(item.previewTargetLinkId, item);
  }
  return { ok: true, items: items.filter(item => !item.previewTemplateEnvironmentId || !item.previewTargetLinkId
    || current.get(item.previewTemplateEnvironmentId)?.get(item.previewTargetLinkId) === item) };
}
