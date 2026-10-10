import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import type { ProviderActionIdV1 } from '@happier-dev/protocol/providers/providerActionIdsV1';
import {
  PROVIDER_ACTION_OUTPUT_SCHEMAS_V1,
  PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1,
  PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1,
} from '@happier-dev/protocol/providers/providerActionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DaemonProviderConnectionMutationResponseV1Schema, DaemonProviderModelSettingsMutationResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { ProviderCliError, type ProviderCliDependencies } from './types';

export type ProviderCliActionExecute = (
  actionId: ProviderActionIdV1,
  input: unknown,
  options?: Readonly<{
    signal?: ActionExecutorContext['signal'];
    preparedSavedSecret?: Awaited<ReturnType<ProviderCliDependencies['createSavedSecret']>>;
  }>,
) => Promise<ActionExecuteResult>;

export function routeProviderCliActions(
  deps: ProviderCliDependencies,
  execute: ProviderCliActionExecute,
): ProviderCliDependencies {
  const run = async (id: ProviderActionIdV1, input: unknown,
    options?: Parameters<ProviderCliActionExecute>[2]) => {
    const result = await execute(id, input, options);
    if (!result.ok) throw new ProviderCliError(result.errorCode, result.error, result.details);
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) throw new ProviderCliError('approval_required', 'Approval requested', approval.data);
    return result.result;
  };
  const mutation = async (input: Parameters<ProviderCliDependencies['connections']['update']>[0]
    | Parameters<ProviderCliDependencies['connections']['setEnabled']>[0]
    | Parameters<ProviderCliDependencies['connections']['setEndpointOverride']>[0]
    | Parameters<ProviderCliDependencies['connections']['bindSecret']>[0]) => {
    const { preparedSavedSecret, ...operand } = 'preparedSavedSecret' in input ? input : { ...input, preparedSavedSecret: undefined };
    const result = DaemonProviderConnectionMutationResponseV1Schema.parse(await run(
      PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1[input.action], operand,
      preparedSavedSecret ? { preparedSavedSecret } : undefined));
    if (result.status === 'error') return result;
    if ('connection' in result) return { status: 'success' as const, ...result.connection };
    throw new ProviderCliError('provider_rpc_response_invalid', 'Provider mutation returned no connection');
  };
  return {
    ...deps,
    connections: {
      ...deps.connections,
      create: async input => {
        const { preparedSavedSecret, ...operand } = input;
        const result = DaemonProviderConnectionMutationResponseV1Schema.parse(await run(
          PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1[input.action], operand,
          preparedSavedSecret ? { preparedSavedSecret } : undefined));
        if (result.status === 'error') return result;
        if ('connection' in result) return { status: 'success', connection: result.connection, created: result.created ?? false };
        throw new ProviderCliError('provider_rpc_response_invalid', 'Provider creation returned no connection');
      },
      update: mutation,
      setEndpointOverride: mutation,
      setEnabled: mutation,
      bindSecret: mutation,
      delete: async input => {
        const result = DaemonProviderConnectionMutationResponseV1Schema.parse(await run('providers.connections.delete', input));
        if (result.status === 'error') return result;
        if ('deletedConnectionId' in result) return { status: 'success', connectionId: result.deletedConnectionId };
        throw new ProviderCliError('provider_rpc_response_invalid', 'Provider deletion returned no connection id');
      },
    },
    probe: async input => PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.probe'].parse(await run('providers.probe', input)),
    loadModel: async ({ signal, ...input }) => PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.models.load']
      .parse(await run('providers.models.load', { action: 'load', ...input }, { signal })),
    mutateModelSettings: async input => DaemonProviderModelSettingsMutationResponseV1Schema
      .parse(await run(PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1[input.action], input)),
  };
}
