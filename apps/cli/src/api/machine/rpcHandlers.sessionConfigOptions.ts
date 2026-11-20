import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpc/errors';
import { SessionConfigOptionRequestSchema, SessionConfigOptionTargetSchema } from '@happier-dev/protocol/sessions/control/sessionConfigOptionV1';

import type { StoredCredentials } from '@/persistence';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { RequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  readSessionConfigOptionChoicesForTarget,
  writeSessionConfigOptionForTarget,
  type SessionConfigOptionControlEnvironment,
} from '@/providers/sessions/sessionConfigOptionControl';

export type WithSessionConfigOptionEnvironment = <T>(
  sessionId: string,
  context: RpcHandlerContext | undefined,
  operation: (environment: SessionConfigOptionControlEnvironment) => Promise<T>,
) => Promise<T>;

export function createSessionConfigOptionEnvironmentOwner(params: Readonly<{
  machineId: string;
  serverId: string;
  credentials: StoredCredentials;
  withSessionAccountContext: RequesterSessionAccountContextCustody['withSessionAccountContext'];
  withSessionAccountHome: RequesterSessionAccountContextCustody['withSessionAccountHome'];
  projectModels?: RuntimeProviderModelManagementServices['projectModels'];
  projectModelsForAccount?: RuntimeProviderModelManagementServices['projectModelsForAccount'];
}>): WithSessionConfigOptionEnvironment {
  return async (sessionId, context, operation) => {
    const signal = context?.signal;
    return await params.withSessionAccountContext(sessionId, async requester => {
      signal?.throwIfAborted();
      if (!requester) {
        const projectModels = params.projectModels;
        return await operation({
          credentials: params.credentials, machineId: params.machineId, signal,
          ...(projectModels ? { readProviderModels: request => projectModels(request, signal, context) } : {}),
        });
      }
      const { credentials, serverHttpBaseUrl } = requester.bootstrap;
      const readSnapshot = () => requester.readAccountSettingsSnapshot();
      return await params.withSessionAccountHome(requester, () => operation({
        credentials, machineId: params.machineId, signal,
        readAccountSettings: () => readSnapshot().settings,
        readProviderModels: request => {
          if (!params.projectModelsForAccount || !requester.resolveManagedPurposeBindingIntent) {
            throw new RpcError('provider_catalog_unavailable', 'provider_catalog_unavailable');
          }
          const isCurrent = () => requester.isCurrent(signal);
          return params.projectModelsForAccount(request, {
            getAccountSettingsSnapshot: readSnapshot,
            resolveManagedPurposeBindingIntent: requester.resolveManagedPurposeBindingIntent,
            resolveManagedPurposeBindingIntentSelection: requester.resolveManagedPurposeBindingIntentSelection,
            savedSecretOperationContext: requester.bootstrap.savedSecretOperationContext,
            signal: signal ?? new AbortController().signal,
            isCurrent,
            accountReadScope: {
              serverUrl: serverHttpBaseUrl,
              readCredentials: async () => credentials,
              readAccountSettingsSnapshot: async () => readSnapshot(),
              isCurrent,
            },
          });
        },
      }));
    }, projectRpcRequesterWorkAttribution(context, params.serverId), signal);
  };
}

export function registerMachineSessionConfigOptionRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  withEnvironment: WithSessionConfigOptionEnvironment;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_CHOICES, async (raw, context) => {
    const { sessionId } = SessionConfigOptionTargetSchema.parse(raw);
    return await params.withEnvironment(sessionId, context, env => readSessionConfigOptionChoicesForTarget(sessionId, env));
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_SET, async (raw, context) => {
    const request = SessionConfigOptionRequestSchema.parse(raw);
    return await params.withEnvironment(request.sessionId, context, env => writeSessionConfigOptionForTarget(request, env));
  });
}
