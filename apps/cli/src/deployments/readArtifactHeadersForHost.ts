import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import type { createCredentialedAccountArtifactStore, ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
    const artifacts = authorization ? readRequesterDeploymentArtifactStore(authorization) : params.artifacts;
    const http = authorization?.requesterHttpProjection;
    if (!artifacts || authorization && !http) throw createActionExecuteFailureError({ ok: false, errorCode: 'project_requester_authority_unavailable', error: 'project_requester_authority_unavailable' });
    const authorizationHeaders: ArtifactRequestAuthorizationHeaders | undefined = http ? async request => {
      const headers = await http.createRequestHeaders({ ...request, effectActionId: authorization!.binding.actionId,
        ...(context.signal ? { signal: context.signal } : {}) });
      if (!headers) throw createActionExecuteFailureError({ ok: false, errorCode: 'project_requester_authority_unavailable', error: 'project_requester_authority_unavailable' });
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
