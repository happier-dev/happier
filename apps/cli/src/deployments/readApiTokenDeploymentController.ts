import axios from 'axios';
import { DeploymentEnvironmentControllerResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { projectHomeAuthorizationHttpFailure } from '@/api/client/homeAuthorizationHttpFailure';

const failure = (errorCode: string): ActionExecuteFailure => ({
  ok: false,
  errorCode,
  error: errorCode,
});

/**
 * Scoped CI placement (plan 40 §6.8): one content-free Home read names the Environment's
 * current controller before an encrypted request seals its target. Its success is the
 * authenticated confirmation that this Home is the step's serverId, so a fresh runner
 * needs no saved Home profile. Home still admits the deploy submission itself.
 */
export async function readApiTokenDeploymentController(
  params: Readonly<{
    serverApiUrl: string;
    bearer: string;
    signal?: AbortSignal;
  }>,
  request: Readonly<{ serverId: string; environmentId: string }>,
): Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure> {
  const headers = {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${params.bearer}`,
  };
  const response = await axios.get<unknown>(
    `${params.serverApiUrl}/v1/deployments/environments/${encodeURIComponent(request.environmentId)}/controller`,
    {
      headers,
      params: { serverId: request.serverId },
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  const parsed = DeploymentEnvironmentControllerResultV1Schema.safeParse(
    response.data,
  );
  if (!parsed.success) {
    if (response.status === 401 || response.status === 403)
      return projectHomeAuthorizationHttpFailure(
        response.status,
        headers,
        response.data,
      );
    return failure(
      response.status === 404 || response.status === 405
        ? 'unsupported_action'
        : 'invalid_action_output',
    );
  }
  if (!parsed.data.ok) return failure(parsed.data.error);
  if (
    parsed.data.serverId !== request.serverId ||
    parsed.data.environmentId !== request.environmentId
  ) {
    return failure('server_scope_mismatch');
  }
  return { ok: true, machineId: parsed.data.controllerMachineId };
}
