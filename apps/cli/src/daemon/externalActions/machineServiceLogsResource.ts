import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenResponseSchema,
  DaemonPluginUiResourceWatchNextResponseSchema, DaemonPluginUiResourceWatchCloseResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1, DATABASE_PLUGIN_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { DATABASE_CONNECTION_RESOURCE_ID_V1 } from '@happier-dev/protocol/databases/databaseResourceIdentityV1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { ActionInvokeInputSchema } from '@happier-dev/protocol/actions/actionInvokeInput';
import { projectTelemetryCaptureResourceDemandV1 } from '@happier-dev/protocol/daemon/machineServiceLogsResource';

type Operands = Pick<ExternalActionRequestEnvelopeV1, 'resourceContinuation' | 'machineServiceLogsGeneration'>;

/** Protected transport operands constrain the same canonical logs Action input. */
export function sameMachineServiceLogsResourceInput(input: unknown, operands: Operands, machineId: string,
  actionId: string = 'machines.services.logs.read'): boolean {
  if (actionId === ACTION_INVOKE_ACTION_ID_V1) {
    const continuation = operands.resourceContinuation;
    const resource = continuation?.params.resource;
    if (!continuation || !resource || continuation.params.machineId !== machineId
      || operands.machineServiceLogsGeneration !== undefined) return false;
    if (resource.hostRead !== 'database.connection' && resource.hostRead !== 'telemetry.capture'
      && resource.hostRead !== 'database.insightSource') return false;
    const parsed = ActionInvokeInputSchema.safeParse(input);
    if (!parsed.success || !sameStrictJsonValue(parsed.data, resource.input)) return false;
    if (resource.hostRead === 'telemetry.capture') return projectTelemetryCaptureResourceDemandV1(resource) !== null;
    if (resource.hostRead === 'database.insightSource') return continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
      && formatQualifiedPluginActionId(parsed.data.action) === DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1;
    const binding = resource.binding;
    return formatQualifiedPluginActionId(parsed.data.action) === DATABASE_DESCRIBE_ACTION_ID_V1
      && binding.callerPluginId === DATABASE_PLUGIN_ID_V1
      && binding.resource.pluginId === binding.callerPluginId && binding.resource.localId === DATABASE_CONNECTION_RESOURCE_ID_V1
      && binding.context?.kind === 'surface' && sameStrictJsonValue(binding.context.launchInput, parsed.data.input);
  }
  if (actionId !== 'machines.services.logs.read' && actionId !== 'machines.services.list'
    && actionId !== 'deployments.logs.read' && actionId !== 'deployments.health.current') return false;
  const parsed = getActionSpec(actionId).inputSchema.safeParse(input);
  // A compact platform log input names no Machine; an explicit selector must be the answering one. The continuation
  // Machine and exact signed input below still bind the read.
  if (!parsed.success || parsed.data.machineId !== undefined && parsed.data.machineId !== machineId) return false;
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
export function parseMachineServiceLogsResourceResponse(method: NonNullable<Operands['resourceContinuation']>['method'], value: unknown):
  ReturnType<typeof DaemonPluginUiResourceReadResponseSchema.safeParse>
  | ReturnType<typeof DaemonPluginUiResourceWatchOpenResponseSchema.safeParse>
  | ReturnType<typeof DaemonPluginUiResourceWatchNextResponseSchema.safeParse>
  | ReturnType<typeof DaemonPluginUiResourceWatchCloseResponseSchema.safeParse> {
  switch (method) {
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ: return DaemonPluginUiResourceReadResponseSchema.safeParse(value);
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN: return DaemonPluginUiResourceWatchOpenResponseSchema.safeParse(value);
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT: return DaemonPluginUiResourceWatchNextResponseSchema.safeParse(value);
    case RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE: return DaemonPluginUiResourceWatchCloseResponseSchema.safeParse(value);
  }
}
