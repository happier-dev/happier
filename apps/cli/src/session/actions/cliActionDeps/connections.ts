import type { CliMachineActionCall } from './machineTransport';
import type { CliActionDepsParams } from './types';
import { createCliProfileActionExecuteV1 } from './createCliProfileActionDeps';
import { createCliMcpServerActionExecuteV1 } from './createCliMcpServerActionDeps';
import { createCliProviderActionExecuteV1 } from './createCliProviderActionDeps';
import { createCliRemoteHostActionExecuteV1 } from './createCliRemoteHostActionDeps';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
export function createCliConnectionsActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'isCredentialCurrent' | 'personalSavedSecretActionExecute' | 'projectModelsForAccount' | 'readProviderForAccount' | 'providerPreparedSavedSecret' | 'savedSecretOperationContext' | 'serverHttpBaseUrl'>,
  { callMachineAction, connectedServiceAction, projectHomeId, registryActionExecute, resolveAuthorizationHeaders }: Readonly<{
    callMachineAction: CliMachineActionCall;
    connectedServiceAction: ActionExecutorDeps['connectedServiceAction'];
    projectHomeId: string;
    registryActionExecute: NonNullable<ActionExecutorDeps['registryActionExecute']>;
    resolveAuthorizationHeaders?: Parameters<typeof createCliMcpServerActionExecuteV1>[0]['resolveAuthorizationHeaders'];
  }>,
): Pick<ActionExecutorDeps, 'profileActionExecute' | 'mcpServerAction' | 'providerActionExecute' | 'remoteHostActionExecute'> {
  return {
    profileActionExecute: params.credentials ? createCliProfileActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
      callMachineAction,
    }) : undefined,
    mcpServerAction: params.credentials ? createCliMcpServerActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
      callMachineAction,
      connectedServiceAction,
      registryActionExecute,
      personalSavedSecretActionExecute: params.personalSavedSecretActionExecute,
      resolveAuthorizationHeaders,
    }) : undefined,
    providerActionExecute: params.credentials ? createCliProviderActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
      ...(params.providerPreparedSavedSecret ? { preparedSavedSecret: params.providerPreparedSavedSecret } : {}),
      ...(params.projectModelsForAccount ? { projectModelsForAccount: params.projectModelsForAccount } : {}),
      ...(params.readProviderForAccount ? { readProviderForAccount: params.readProviderForAccount } : {}),
      ...(params.isCredentialCurrent ? { isCredentialCurrent: params.isCredentialCurrent } : {}),
      callMachineAction,
    }) : undefined,
    remoteHostActionExecute: params.credentials ? createCliRemoteHostActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
    }) : undefined,
  };
}
