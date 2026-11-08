import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createCredentialedAccountArtifactStore, type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readRequesterDeploymentArtifactStore } from '@/daemon/sessionEncryption/requesterAccountActionProjection';

/** Reuses requester custody and the Artifact header transport; never borrows a receiving host's Account. */
export function createDeploymentArtifactHeaderReader(params: Readonly<{
  serverHttpBaseUrl: string;
  artifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
  assertCurrent(context: Parameters<NonNullable<ActionExecutorDeps['deploymentReadArtifactHeaders']>>[1]): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['deploymentReadArtifactHeaders']> {
  return async (artifactIds, context) => {
    if (artifactIds.length === 0) return [];
    await params.assertCurrent(context);
    const authorization = context.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    const artifacts = authorization ? readRequesterDeploymentArtifactStore(authorization)
      ?? (requester ? createCredentialedAccountArtifactStore(requester.credentials) : null) : params.artifacts;
    const http = authorization?.requesterHttpProjection;
    if (!artifacts || authorization && !http) throw Object.assign(new Error('project_requester_authority_unavailable'),
      { code: 'project_requester_authority_unavailable' });
    const authorizationHeaders: ArtifactRequestAuthorizationHeaders | undefined = http ? async request => {
      const headers = await http.createRequestHeaders({ ...request, effectActionId: authorization!.binding.actionId,
        ...(context.signal ? { signal: context.signal } : {}) });
      if (!headers) throw Object.assign(new Error('project_requester_authority_unavailable'),
        { code: 'project_requester_authority_unavailable' });
      return headers;
    } : undefined;
    const read = artifacts.createHeaderReader({ prepareRecipients: false, ...(context.signal ? { signal: context.signal } : {}),
      ...(authorizationHeaders ? { authorizationHeaders } : {}) });
    const result = await runWithServerHttpBaseUrl(http?.serverHttpBaseUrl ?? params.serverHttpBaseUrl, () =>
      Promise.allSettled(artifactIds.map(async artifactId => {
        const header = await read(artifactId);
        return header?.bodyVersion === undefined ? null : { artifactId: header.artifactId, header: header.header,
          revision: { headerVersion: header.headerVersion, bodyVersion: header.bodyVersion } };
      })));
    await params.assertCurrent(context);
    return result;
  };
}
