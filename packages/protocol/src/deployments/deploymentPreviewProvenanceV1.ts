import type { DeploymentDomainHeaderV1 } from './deploymentDomainV1.js';
import type { DeploymentEnvironmentHeaderV1, DeploymentReceiptHeaderV1 } from './deploymentHeadersV1.js';
import type { DeploymentEnvironmentListInputV1, DeploymentTargetLinkHeaderV1 } from './deploymentActionsV1.js';
import type { ScmHostingRepositoryIdentityV1 } from '../scm/hostingRepositoryIdentity.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';

/** Protected provenance only; the admitted template relation owns live Action preferences. */
export const DeploymentPreviewProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), templateEnvironmentId: id, runtimeTargetLinkId: id,
  repository: ScmHostingRepositoryIdentityV1Schema,
  pullRequestId: id, pullRequestNumber: z.number().check(z.int(), z.positive()),
  author: z.strictObject({ id, login: z.string().check(z.trim(), z.minLength(1)) }),
  headRepository: ScmHostingRepositoryIdentityV1Schema,
}));
export type DeploymentPreviewProvenanceV1 = z.infer<typeof DeploymentPreviewProvenanceV1Schema>;
export const DeploymentPreviewProvenanceV1ProtocolSchema = projectZodProtocolSchema(DeploymentPreviewProvenanceV1Schema);

/** Shared for received and polled head observations. An unserved head still needs a deployment. */
export function deploymentPreviewHeadNeedsRedeployV1(servingSha: string | null, observedSha: string): boolean {
    return servingSha?.toLowerCase() !== observedSha.toLowerCase();
}

/** For one PR, an active child supersedes an older tombstone for the same template target. */
export function selectCurrentPreviewEnvironmentsV1<T extends Pick<DeploymentEnvironmentHeaderV1,
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

export function isOwnServerPreviewTargetV1(link: Pick<DeploymentTargetLinkHeaderV1, 'source' | 'targetKind'>): boolean {
  return link.source.kind === 'host' && link.source.id === 'own-server' && link.targetKind === 'ownServer';
}

export function isReadyDeploymentPreviewDomainV1(
    domain: Pick<DeploymentDomainHeaderV1, 'environmentId' | 'targetLinkId' | 'state' | 'deletedAtMs'>,
    link: Pick<DeploymentTargetLinkHeaderV1, 'id' | 'environmentId'>,
): boolean {
    return domain.environmentId === link.environmentId && domain.targetLinkId === link.id
        && domain.state === 'active' && domain.deletedAtMs === undefined;
}

export function projectDeploymentPreviewStateV1(deployment: Pick<DeploymentReceiptHeaderV1, 'operation' | 'state'>, targetUrl: string | null) {
  if (deployment.operation === 'teardown' && deployment.state === 'succeeded') return 'removed';
  if (deployment.state === 'failed' || deployment.state === 'cancelled') return 'failed';
  return deployment.state === 'succeeded' && targetUrl !== null ? 'ready' : 'deploying';
}

export function applyDeploymentPreviewHeadV1(preview: Readonly<{
  state: ReturnType<typeof projectDeploymentPreviewStateV1>;
  servingSha: string;
  targetUrl: string | null;
}>, headSha: string) {
  const state = deploymentPreviewHeadNeedsRedeployV1(preview.servingSha, headSha) ? 'outdated' : preview.state;
  return { state, targetUrl: state === 'ready' ? preview.targetUrl : null };
}

/** Preview reads include tombstones so a finished cleanup can still be presented. */
export function buildDeploymentPreviewEnvironmentQueryV1(
    serverId: string, previewRepository: ScmHostingRepositoryIdentityV1, pullRequestIds: readonly string[],
): DeploymentEnvironmentListInputV1 {
    return { serverId, includeDeleted: true, previewRepository, previewPullRequestIds: [...pullRequestIds] };
}
