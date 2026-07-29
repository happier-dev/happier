import {
  ProviderMachineIdSchema,
  createProviderErrorV1,
} from '@happier-dev/protocol';
import {
  DaemonProviderModelLoadRequestV1Schema,
  type DaemonProviderModelLoadRequestV1,
} from '@happier-dev/protocol/rpc';

import type { ProviderModelLoadRequest, ProviderModelLoadResult } from './load';

export const ProviderModelLoadRpcRequestSchema = DaemonProviderModelLoadRequestV1Schema;
export type ProviderModelLoadRpcRequest = DaemonProviderModelLoadRequestV1;

type ProviderModelLoadRpcDependencies = Readonly<{
  machineId: string;
  loadNow(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult>;
  cancelNow(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult>;
}>;

async function executeProviderModelLoad(
  dependencies: ProviderModelLoadRpcDependencies,
  input: ProviderModelLoadRpcRequest,
  context: Readonly<{ signal?: AbortSignal }>,
): Promise<ProviderModelLoadResult> {
  const ownedMachineId = ProviderMachineIdSchema.parse(dependencies.machineId);
  if (input.machineId !== ownedMachineId) {
    return {
      status: 'error',
      error: createProviderErrorV1('provider_not_enabled_on_machine', {
        connectionId: input.connectionId,
        machineId: input.machineId,
      }),
    };
  }
  const request = {
    connectionId: input.connectionId,
    machineId: input.machineId,
    modelId: input.modelId,
    ...(context.signal ? { signal: context.signal } : {}),
  };
  return input.action === 'cancel'
    ? dependencies.cancelNow(request)
    : dependencies.loadNow(request);
}

/** Strict machine-RPC surface. No endpoint, descriptor, body, or credential is admitted. */
export function createProviderModelLoadRpcHandler(dependencies: ProviderModelLoadRpcDependencies) {
  return async (
    rawInput: unknown,
    context: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ProviderModelLoadResult> => executeProviderModelLoad(
    dependencies,
    ProviderModelLoadRpcRequestSchema.parse(rawInput),
    context,
  );
}
