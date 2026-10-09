import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import type { WorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import type { DirectTransferServerLifecycle } from './directTransferServerLifecycle';

/** Publish the source owner's fenced seed and its existing on-demand blobs. */
export async function prepareWorkspaceSyncSeedExport(params: Readonly<{
  lifecycle: Pick<DirectTransferServerLifecycle, 'publishTransferWhenReady'>;
  request: Parameters<WorkspaceSyncTargetAuthority['prepareSourceSeedExport']>[0];
  prepareSourceSeedExport: WorkspaceSyncTargetAuthority['prepareSourceSeedExport'];
}>): Promise<Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  expiresAt: number;
  sizeBytes?: number;
  manifestHash?: string;
}>> {
  const prepared = await params.prepareSourceSeedExport(params.request);
  const published = await params.lifecycle.publishTransferWhenReady({
    transferId: params.request.operationId,
    payloadSource: prepared.payloadSource,
    onDemandScope: prepared.onDemandScope,
  });
  return {
    transferId: published.transferId,
    endpointCandidates: published.endpointCandidates,
    expiresAt: published.expiresAt,
    ...(prepared.payloadSource.sizeBytes === undefined ? {} : { sizeBytes: prepared.payloadSource.sizeBytes }),
    ...(prepared.payloadSource.manifestHash === undefined ? {} : { manifestHash: prepared.payloadSource.manifestHash }),
  };
}
