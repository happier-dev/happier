import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachineServiceLogsReadInputV1Schema } from '../local/services/nativeLogsV1.js';
import { MachineServicesListInputV1Schema } from '../actions/specs/machine/services.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { DeploymentHealthCurrentInputV1Schema, DeploymentStageLogsReadInputV1Schema } from '../deployments/deploymentReadsV1.js';

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
  hostRead: z.literal('deployments.logs'), input: z.extend(DeploymentStageLogsReadInputV1Schema, { tail: z.literal(true) }),
  sourceRevision: z.string().check(z.trim(), z.minLength(1)),
}));
export const PluginUiMachineServiceReadReferenceV1Schema = lazyZodSchema(() => z.union([
  PluginUiMachineServiceLogsReadReferenceV1Schema, PluginUiMachineServicesListReadReferenceV1Schema,
  PluginUiDeploymentStageLogsReadReferenceV1Schema,
  PluginUiDeploymentEdgeHealthReadReferenceV1Schema,
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
