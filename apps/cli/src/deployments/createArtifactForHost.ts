import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';

type ArtifactStore = ReturnType<typeof createCredentialedAccountArtifactStore>;

/** Private deployment content follows its owner and, for receipts, the Environment audience. */
export async function createDeploymentArtifactForHost(input: Readonly<{
    artifacts: Pick<ArtifactStore, 'create' | 'accessGrants' | 'readForUpdate' | 'update'>;
    owner: DeploymentEnvironmentDetailV1['environment']['owner'];
    content: Parameters<ArtifactStore['create']>[0];
    assertCurrent(): Promise<void>;
}>): Promise<Awaited<ReturnType<ArtifactStore['create']>>> {
    // A signed native root retains its issued candidate through pending wake.
    // It may already have an unadmitted head: preserve its real CAS rather than
    // treating idempotent create's old response as freshly prepared content.
    const resource = input.content.artifactId ? await input.artifacts.readForUpdate(input.content.artifactId, {
        signal: input.content.signal, prepareRecipients: false, includeSharedAudience: false,
        authorizationHeaders: input.content.authorizationHeaders,
    }) : null;
    const existing = resource?.artifact;
    let created: Awaited<ReturnType<ArtifactStore['create']>>;
    if (existing) {
        if (existing.header.kind !== input.content.header.kind || existing.access !== 'owner') {
            throw Object.assign(new Error('deployment_content_unavailable'), { code: 'deployment_content_unavailable' });
        }
        await input.assertCurrent();
        const updated = await input.artifacts.update({ ...input.content, artifactId: existing.artifactId,
            expectedRevision: existing.revision });
        if (!updated.ok) throw Object.assign(new Error(updated.errorCode), { code: updated.errorCode });
        created = { artifactId: existing.artifactId, revision: updated.revision };
    } else created = await input.artifacts.create(input.content);
    // Receipt publication applies the Environment audience at the server owner.
    // Its codec prepares that admitted audience, without selecting grants here.
    if (!input.content.prepareRecipients && input.owner.kind === 'team') {
        await input.assertCurrent();
        const shared = await input.artifacts.accessGrants.set({ artifactId: created.artifactId,
            principal: input.owner, accessLevel: 'admin' }, input.content.signal,
            { authorizationHeaders: input.content.authorizationHeaders });
        if (shared.preparation?.status === 'pending') {
            throw Object.assign(new Error('deployment_content_unavailable'), { code: 'deployment_content_unavailable' });
        }
        await input.assertCurrent();
    }
    return created;
}
