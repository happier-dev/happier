import axios from '@/api/client/credentialAxios';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  ProjectDeploymentDefaultsOutputV1Schema,
  type ProjectDeploymentDefaultsOutputV1,
} from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';

/** The Source's deployment-defaults reference, read under the invoking Action's own Home authority. */
export async function readProjectDeploymentDefaultsForHost(
  host: Readonly<{
    homeId: string;
    serverHttpBaseUrl: string;
    headers(
      context: ActionExecutorContext,
      effectActionId: string,
      request: Readonly<{ method: string; path: string; body?: unknown }>,
    ): Promise<Readonly<Record<string, string>> | null>;
  }>,
  sourceId: string,
  context: ActionExecutorContext,
  effectActionId: string,
): Promise<ProjectDeploymentDefaultsOutputV1 | ActionExecuteFailure> {
  const homeId =
    context.externalActionExecutionAuthorization?.binding.serverIdentityId ??
    host.homeId;
  const path = `/v1/projects/${encodeURIComponent(sourceId)}/deployment-defaults?serverId=${encodeURIComponent(homeId)}`;
  const headers = await host.headers(context, effectActionId, {
    method: 'GET',
    path,
  });
  if (!headers)
    return {
      ok: false,
      errorCode: 'project_requester_authority_unavailable',
      error: 'project_requester_authority_unavailable',
    };
  const response = await axios.request<unknown>({
    method: 'GET',
    url: `${host.serverHttpBaseUrl}${path}`,
    headers,
    signal: context.signal,
    validateStatus: () => true,
  });
  return ProjectDeploymentDefaultsOutputV1Schema.parse(response.data);
}
