import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentEnvironmentGetResultV1Schema, resolveDeploymentEnvironmentExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';

const actionFailure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });

export function resolveRequesterDeploymentMachine(params: Readonly<{
  actionId: string;
  input: unknown;
  credentials: StoredCredentials;
  serverApiUrl: string;
  serverId: string;
  context: ActionExecutorContext;
}>) {
  return resolveDeploymentEnvironmentExecutionMachineIdV1(params.actionId, params.input, {
    readEnvironmentController: async request => {
      const { deploymentAction } = createCliDeploymentActionDeps({
        serverHttpBaseUrl: params.serverApiUrl,
        // The URL is fixed and Home refuses a step naming another Home; a fresh runner has no saved profile.
        admitAccount: () => null,
        resolveRequestHeaders: () => ({ ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${params.credentials.token}` }),
        dispatchReceipt: async () => actionFailure('deployment_executor_unavailable'),
      });
      const loaded = await deploymentAction!(DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, request, params.context);
      if ('errorCode' in loaded) return loaded;
      const result = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
      return result.ok ? { ok: true, machineId: result.environment.controllerMachineId } : actionFailure(result.error);
    },
  });
}
