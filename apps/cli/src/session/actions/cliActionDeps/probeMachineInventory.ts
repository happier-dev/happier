import type { ActionExecutorContext, ActionExecutorDeps, BackendTargetRefV2 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { convertBackendTargetRefV2ToV1 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readCapabilityInvokeFailure } from '@happier-dev/protocol/capabilities';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { z } from 'zod/mini';
import type { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

/** The selected Machine, not the calling MCP process, owns native inventory. */
export function createMachineInventoryProbe(params: Pick<Parameters<typeof createCliActionInventoryDeps>[0], 'callMachineAction' | 'serverId'>) {
  return async <T extends { agentId?: string; source?: 'static' | 'dynamic' | 'unavailable'; runtimeDescriptorV1Accepted?: boolean }>(input: Readonly<{
    args: Parameters<NonNullable<ActionExecutorDeps['agentsModelsList']>>[0];
    context?: ActionExecutorContext;
    agentId: string;
    backendTarget: BackendTargetRefV2 | null;
    method: 'probeModels' | 'probeConfigOptions';
    schema: z.ZodMiniType<T>;
  }>): Promise<T | ActionExecuteFailure | null> => {
    if (!params.callMachineAction || !input.args.machineId) return null;
    const { transportTimeoutMs, ...probe } = input.args.probe ?? {};
    const signal = input.args.signal ?? input.context?.signal;
    const failed = (error: unknown): ActionExecuteFailure => {
      const failure = readCapabilityInvokeFailure(error);
      const errorCode = failure?.errorCode ?? 'agent_inventory_probe_failed';
      return { ok: false, errorCode, error: errorCode,
        ...(failure?.retryable === undefined ? {} : { details: { retryable: failure.retryable } }) };
    };
    try {
      const response = await params.callMachineAction({ machineId: input.args.machineId,
        serverId: input.args.serverId ?? input.context?.serverId ?? params.serverId, method: RPC_METHODS.CAPABILITIES_INVOKE,
        request: { id: `cli.${input.agentId}`, method: input.method, params: {
          ...probe,
          ...(input.backendTarget ? { backendTarget: convertBackendTargetRefV2ToV1(input.backendTarget) } : {}),
        } }, context: input.context,
        effectActionId: input.method === 'probeModels' ? 'agents.models.list' : 'agents.config_options.list',
        ...(signal ? { signal } : {}),
        ...(transportTimeoutMs === undefined ? {} : { timeoutMs: transportTimeoutMs }),
      });
      if (!response || typeof response !== 'object' || !('ok' in response)) return null;
      if (response.ok === false) {
        const error = 'error' in response ? response.error : null;
        return failed(error && typeof error === 'object' ? { ...error, errorCode: 'code' in error ? error.code : undefined } : error);
      }
      if (response.ok !== true || !('result' in response)) return null;
      const observation = input.schema.safeParse(response.result);
      if (!observation.success || observation.data.agentId && observation.data.agentId !== input.agentId
        || input.method === 'probeModels' && input.args.probe?.runtimeDescriptorV1 && observation.data.runtimeDescriptorV1Accepted !== true) return null;
      return { ...observation.data, source: observation.data.source ?? 'dynamic' };
    } catch (error) {
      signal?.throwIfAborted();
      return failed(error);
    }
  };
}
