import type { DeploymentsActionResultById } from '@happier-dev/plugin-sdk/actions';
import { deploymentPreviewHeadNeedsRedeployV1 } from '@happier-dev/plugin-sdk/protocol';

type Environment = Extract<DeploymentsActionResultById['deployments.environments.list'], { ok: true }>['items'][number];
type EnvironmentDetail = Extract<DeploymentsActionResultById['deployments.environments.get'], { ok: true }>;
type Receipt = Extract<DeploymentsActionResultById['deployments.receipts.list'], { ok: true }>['items'][number];

/** For one PR, an active child supersedes an older tombstone for the same template target. */
export function selectGithubCurrentPreviewEnvironmentsV1<T extends Pick<Environment,
  'previewTemplateEnvironmentId' | 'previewTargetLinkId' | 'deletedAtMs'>>(items: readonly T[]): T[] {
  const current = new Map<string, Map<string, T>>();
  for (const item of items) {
    if (!item.previewTemplateEnvironmentId || !item.previewTargetLinkId) continue;
    let targets = current.get(item.previewTemplateEnvironmentId);
    if (!targets) { targets = new Map(); current.set(item.previewTemplateEnvironmentId, targets); }
    const previous = targets.get(item.previewTargetLinkId);
    if (!previous || previous.deletedAtMs !== undefined && item.deletedAtMs === undefined) targets.set(item.previewTargetLinkId, item);
  }
  return items.filter(item => !item.previewTemplateEnvironmentId || !item.previewTargetLinkId
    || current.get(item.previewTemplateEnvironmentId)?.get(item.previewTargetLinkId) === item);
}

export function isGithubOwnServerPreviewTargetV1(link: Pick<EnvironmentDetail['targetLinks'][number], 'source' | 'targetKind'>): boolean {
  return link.source.kind === 'host' && link.source.id === 'own-server' && link.targetKind === 'ownServer';
}

export function projectGithubPreviewStateV1(deployment: Pick<Receipt, 'operation' | 'state'>, targetUrl: string | null) {
  if (deployment.operation === 'teardown' && deployment.state === 'succeeded') return 'removed';
  if (deployment.state === 'failed' || deployment.state === 'cancelled') return 'failed';
  return deployment.state === 'succeeded' && targetUrl !== null ? 'ready' : 'deploying';
}

export function applyGithubPreviewHeadV1(preview: Readonly<{
  state: ReturnType<typeof projectGithubPreviewStateV1>;
  servingSha: string;
  targetUrl: string | null;
}>, headSha: string) {
  const state = deploymentPreviewHeadNeedsRedeployV1(preview.servingSha, headSha) ? 'outdated' : preview.state;
  return { state, targetUrl: state === 'ready' ? preview.targetUrl : null };
}
