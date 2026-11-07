import { createHash } from 'node:crypto';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { GITHUB_DEPLOYMENT_REVIEW_CATEGORY_ID, GITHUB_DEPLOYMENT_REVIEW_PAGE_ID, encodeGithubDeploymentReviewLocationV1,
  type GithubDeploymentNoticeFactsV1, type GithubDeploymentReviewLocationV1 } from './deploymentReviewProtocol.js';

function itemId(value: GithubDeploymentReviewLocationV1): string {
  return `github.com/${value.repositoryId}/${value.runId}/${value.attempt}/${value.environmentId}`;
}

function sameFacts(left: GithubDeploymentNoticeFactsV1, right: GithubDeploymentNoticeFactsV1): boolean {
  return left.environmentName === right.environmentName && left.eligible === right.eligible && left.waitUntilMs === right.waitUntilMs
    && left.reviewers?.length === right.reviewers?.length && (left.reviewers?.every((reviewer, index) => reviewer === right.reviewers?.[index]) ?? true);
}

/** The same canonical checkpoint retains equal facts; no poll timestamp enters it. */
export function reconcileGithubDeploymentNoticeFactsV1(previous: readonly GithubDeploymentNoticeFactsV1[], incoming: readonly GithubDeploymentNoticeFactsV1[]): readonly GithubDeploymentNoticeFactsV1[] {
  const previousById = new Map(previous.map(value => [itemId(value), value]));
  const incomingById = new Map(incoming.map(value => [itemId(value), value]));
  // Pending environments are a set, not provider-ranked rows. Preserve the
  // checkpoint's order so an API-only reorder cannot create a semantic write.
  const ordered = [...previous.flatMap(value => incomingById.has(itemId(value)) ? [incomingById.get(itemId(value))!] : []),
    ...incoming.filter(value => !previousById.has(itemId(value)))];
  const rows = ordered.map(value => {
    const retained = previousById.get(itemId(value));
    return retained && sameFacts(retained, value) ? retained : value;
  });
  return rows.length === previous.length && rows.every((value, index) => value === previous[index]) ? previous : rows;
}

function hasReviewPage(manifest: Pick<PluginManifest, 'contributes'>): boolean {
  const view = manifest.contributes?.ui?.views?.find(view => view.id === GITHUB_DEPLOYMENT_REVIEW_PAGE_ID && view.container === 'appPage' && view.target.kind === 'app');
  return view !== undefined && manifest.contributes?.ui?.renderers?.some(renderer => renderer.id === view.renderer && renderer.kind === 'reactNative' && renderer.artifact === 'github-forge-native') === true;
}

export async function publishGithubDeploymentReviewNoticesV1(input: Readonly<{
  current: readonly GithubDeploymentNoticeFactsV1[];
  /** Only a complete authoritative pending observation may remove these rows. */
  previous: readonly GithubDeploymentNoticeFactsV1[];
  manifest: Pick<PluginManifest, 'contributes'>;
  /** Existing source checkpoint revision; stable across retries of this transition. */
  observationId: string;
  isCurrent: () => Promise<boolean>;
}>, context: PluginInvocationContext): Promise<Readonly<{ kind: 'published' }> | Readonly<{ kind: 'unavailable'; code: string }>> {
  if (!hasReviewPage(input.manifest)) return { kind: 'unavailable', code: 'github_deployment_review_page_unavailable' };
  // Validate every target before the first send: a malformed later row cannot
  // produce a partial batch with a generic fallback destination.
  const currentIds = new Set<string>();
  for (const value of [...input.current, ...input.previous]) {
    if (encodeGithubDeploymentReviewLocationV1(value) === null) return { kind: 'unavailable', code: 'github_deployment_review_location_invalid' };
  }
  for (const value of input.current) {
    const id = itemId(value);
    if (currentIds.has(id)) return { kind: 'unavailable', code: 'github_deployment_review_location_invalid' };
    currentIds.add(id);
  }
  const previous = new Map(input.previous.map(value => [itemId(value), value]));
  const changes = [
    ...input.current.filter(value => { const prior = previous.get(itemId(value)); return !prior || !sameFacts(prior, value); }).map(value => ({ value, resolved: false })),
    ...input.previous.filter(value => !currentIds.has(itemId(value))).map(value => ({ value, resolved: true })),
  ];
  for (const { value, resolved } of changes) {
    context.signal.throwIfAborted();
    if (!(await input.isCurrent())) return { kind: 'unavailable', code: 'github_deployment_monitor_placement_stale' };
    context.signal.throwIfAborted();
    const id = itemId(value);
    const requestId = createHash('sha256').update(JSON.stringify([input.observationId, id, value.environmentName, value.eligible, value.waitUntilMs ?? null, value.reviewers ?? null, resolved])).digest('hex');
    await context.services.notifications.send({
      clientRequestId: `github-deployment-review:${requestId}`,
      categoryId: GITHUB_DEPLOYMENT_REVIEW_CATEGORY_ID,
      itemId: id,
      type: value.eligible && !resolved ? 'approval' : 'update',
      title: resolved ? `Deployment review resolved: ${value.environmentName}` : `Deployment review: ${value.environmentName}`,
      body: resolved ? 'Open to inspect the current deployment state.' : value.eligible ? 'Review the selected environment before allowing or denying deployment.' : 'This deployment is waiting on protection rules. You cannot currently approve it.',
      page: { pageId: GITHUB_DEPLOYMENT_REVIEW_PAGE_ID, subPath: encodeGithubDeploymentReviewLocationV1(value)! },
      resolved,
    }, { signal: context.signal });
  }
  return { kind: 'published' };
}
