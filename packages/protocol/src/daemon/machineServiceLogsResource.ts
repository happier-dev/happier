import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachineServiceLogsReadInputV1Schema } from '../local/services/nativeLogsV1.js';
import { MachineServicesListInputV1Schema } from '../actions/specs/machine/services.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { DeploymentHealthCurrentInputV1Schema, DeploymentStageLogsReadInputV1Schema, DeploymentRuntimeLogsReadInputV1Schema } from '../deployments/deploymentReadsV1.js';
import { ActionInvokeInputSchema, type ActionInvokeInput } from '../actions/actionInvokeInput.js';
import { PluginUiDeclaredResourceBindingV1Schema } from '../plugins/ui/resourceBinding.js';
import { DATABASE_CONNECTION_RESOURCE_ID_V1 } from '../databases/databaseResourceIdentityV1.js';
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_PLUGIN_ID_V1 } from '../actions/actionIdsDatabaseV1.js';
import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';

/** Protected operands of the original semantic describe invocation and mounted Resource. */
export type PluginUiDatabaseConnectionReadReferenceV1 = {
  hostRead: 'database.connection';
  input: ActionInvokeInput;
  binding: z.output<typeof PluginUiDeclaredResourceBindingV1Schema>;
};
type PluginUiDatabaseConnectionReadReferenceV1Input = Omit<PluginUiDatabaseConnectionReadReferenceV1, 'input' | 'binding'> & {
  input: z.input<typeof ActionInvokeInputSchema>;
  binding: z.input<typeof PluginUiDeclaredResourceBindingV1Schema>;
};
export const PluginUiDatabaseConnectionReadReferenceV1Schema: z.ZodMiniType<
  PluginUiDatabaseConnectionReadReferenceV1, PluginUiDatabaseConnectionReadReferenceV1Input
> = lazyZodSchema(() => z.strictObject({
  hostRead: z.literal('database.connection'), input: ActionInvokeInputSchema,
  binding: PluginUiDeclaredResourceBindingV1Schema,
}));

/** The existing declared connection Resource borrows its semantic describe admission. */
export function projectDatabaseConnectionResourceReadV1(binding: z.infer<typeof PluginUiDeclaredResourceBindingV1Schema>):
  z.infer<typeof PluginUiDatabaseConnectionReadReferenceV1Schema> | null {
  if (binding.callerPluginId !== DATABASE_PLUGIN_ID_V1 || binding.resource.pluginId !== DATABASE_PLUGIN_ID_V1
    || binding.resource.localId !== DATABASE_CONNECTION_RESOURCE_ID_V1 || binding.context?.kind !== 'surface') return null;
  const action = parseQualifiedPluginActionId(DATABASE_DESCRIBE_ACTION_ID_V1);
  if (!action) throw new TypeError('The canonical database describe Action must have a qualified identity');
  return { hostRead: 'database.connection', input: { action, input: binding.context.launchInput }, binding };
}

/** Native identity only. The original logs Action remains the admission owner. */
export const PluginUiMachineServiceLogsReadReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  hostRead: z.literal('machines.services.logs'),
  input: MachineServiceLogsReadInputV1Schema,
  expectedGeneration: z.string().check(z.trim(), z.minLength(1)),
  sourceRevision: z.string().check(z.trim(), z.minLength(1)),
}));

export const DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS = 1_000;
export const DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS = 60_000;
export const DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS = 25_000;

export const PluginUiMachineServicesListReadReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  hostRead: z.literal('machines.services.list'), input: MachineServicesListInputV1Schema,
}));
export const PluginUiDeploymentEdgeHealthReadReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  hostRead: z.literal('deployments.health.edge'), input: DeploymentHealthCurrentInputV1Schema,
}));
/** Same admitted deployment logs Action and native Resource lifetime; no second log endpoint. */
export const PluginUiDeploymentStageLogsReadReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  hostRead: z.literal('deployments.logs'), input: z.discriminatedUnion('kind', [
    z.extend(DeploymentStageLogsReadInputV1Schema, { tail: z.literal(true) }), DeploymentRuntimeLogsReadInputV1Schema,
  ]),
  sourceRevision: z.string().check(z.trim(), z.minLength(1)),
}));
export const PluginUiMachineServiceReadReferenceV1Schema = lazyZodSchema(() => z.union([
  PluginUiMachineServiceLogsReadReferenceV1Schema, PluginUiMachineServicesListReadReferenceV1Schema,
  PluginUiDeploymentStageLogsReadReferenceV1Schema,
  PluginUiDeploymentEdgeHealthReadReferenceV1Schema,
  PluginUiDatabaseConnectionReadReferenceV1Schema,
]));
const target = () => ({ machineId: z.string().check(z.trim(), z.minLength(1)),
  resource: PluginUiMachineServiceReadReferenceV1Schema });
const subscription = () => ({ ...target(), subscriptionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) });
export const DaemonMachineServiceLogsResourceReadRequestSchema = lazyZodSchema(() => z.strictObject(target()));
export const DaemonMachineServiceLogsResourceWatchOpenRequestSchema = lazyZodSchema(() => z.strictObject(subscription()));
export const DaemonMachineServiceLogsResourceWatchNextRequestSchema = lazyZodSchema(() => z.strictObject({ ...subscription(),
  waitMs: z.optional(z.number().check(z.int(), z.minimum(DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS), z.maximum(DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS))),
}));
export const DaemonMachineServiceLogsResourceWatchCloseRequestSchema = lazyZodSchema(() => z.strictObject(subscription()));

/** Protected operands of the SAME original logs invocation, never a second Action. */
export const MachineServiceLogsResourceContinuationV1Schema = lazyZodSchema(() => z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ), params: DaemonMachineServiceLogsResourceReadRequestSchema }),
  z.strictObject({ method: z.literal(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN), params: DaemonMachineServiceLogsResourceWatchOpenRequestSchema }),
  z.strictObject({ method: z.literal(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT), params: DaemonMachineServiceLogsResourceWatchNextRequestSchema }),
  z.strictObject({ method: z.literal(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE), params: DaemonMachineServiceLogsResourceWatchCloseRequestSchema }),
]));
export const MachineServiceLogsGenerationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedGeneration: z.string().check(z.trim(), z.minLength(1)),
}));
