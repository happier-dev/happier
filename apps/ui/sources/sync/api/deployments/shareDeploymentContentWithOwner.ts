import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/**
 * Home admits a Team Environment's content only when the owning Team administers it, so new content is shared with
 * the Team before the Action that references it. An Account owner already owns what it wrote.
 */
export async function shareDeploymentContentWithOwner(account: Pick<LazyActionAccountContext, 'artifactAccessGrants'>,
    artifactId: string, owner: ProjectSourceOwnerV1, signal: AbortSignal | undefined): Promise<void> {
    if (owner.kind !== 'team') return;
    const shared = await account.artifactAccessGrants.set({ artifactId, principal: owner, accessLevel: 'admin' }, signal);
    if (shared.preparation?.status === 'pending') {
        throw Object.assign(new Error('deployment_content_unavailable'), { code: 'deployment_content_unavailable' });
    }
}
