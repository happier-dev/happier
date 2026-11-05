import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenResponseSchema,
  DaemonPluginUiResourceWatchNextResponseSchema, DaemonPluginUiResourceWatchCloseResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

type Operands = Pick<ExternalActionRequestEnvelopeV1, 'resourceContinuation' | 'machineServiceLogsGeneration'>;

/** Protected transport operands constrain the same canonical logs Action input. */
export function sameMachineServiceLogsResourceInput(input: unknown, operands: Operands, machineId: string,
  actionId: string = 'machines.services.logs.read'): boolean {
  if (actionId !== 'machines.services.logs.read' && actionId !== 'machines.services.list'
    && actionId !== 'deployments.logs.read' && actionId !== 'deployments.health.current') return false;
  const parsed = getActionSpec(actionId).inputSchema.safeParse(input);
  if (!parsed.success || parsed.data.machineId !== machineId) return false;
  const continuation = operands.resourceContinuation;
  if (!continuation) return actionId === 'machines.services.logs.read' && operands.machineServiceLogsGeneration !== undefined;
  const { resource } = continuation.params;
  if (actionId === 'deployments.logs.read') return resource.hostRead === 'deployments.logs'
    && operands.machineServiceLogsGeneration === undefined && continuation.params.machineId === machineId
    && sameStrictJsonValue(parsed.data, resource.input);
  if (actionId === 'deployments.health.current') return resource.hostRead === 'deployments.health.edge'
    && operands.machineServiceLogsGeneration === undefined && continuation.params.machineId === machineId
    && sameStrictJsonValue(parsed.data, resource.input);
  if (actionId === 'machines.services.list') return resource.hostRead === 'machines.services.list'
    && operands.machineServiceLogsGeneration === undefined && continuation.params.machineId === machineId
    && sameStrictJsonValue(parsed.data, resource.input);
  if (resource.hostRead !== 'machines.services.logs') return false;
  return continuation.params.machineId === machineId && resource.input.machineId === machineId
    && sameStrictJsonValue(parsed.data, getActionSpec('machines.services.logs.read').inputSchema.parse(resource.input))
    && (!operands.machineServiceLogsGeneration || operands.machineServiceLogsGeneration.expectedGeneration === resource.expectedGeneration);
}

/** Resource phases keep their existing closed responses; finite Action output stays unchanged. */
export function parseMachineServiceLogsResourceResponse(method: NonNullable<Operands['resourceContinuation']>['method'], value: unknown) {
  switch (method) {
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ: return DaemonPluginUiResourceReadResponseSchema.safeParse(value);
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN: return DaemonPluginUiResourceWatchOpenResponseSchema.safeParse(value);
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT: return DaemonPluginUiResourceWatchNextResponseSchema.safeParse(value);
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE: return DaemonPluginUiResourceWatchCloseResponseSchema.safeParse(value);
  }
}
