import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { MachineServiceLogsReadInputV1Schema, ManagedServiceNativeLogResultV1Schema, ManagedServiceUnavailableReasonV1Schema } from '../../../local/services/nativeLogsV1.js';
export { MachineServiceLogsReadInputV1Schema, type MachineServiceLogsReadInputV1 } from '../../../local/services/nativeLogsV1.js';
import { ManagedServiceNativeStateV1Schema } from '../../../local/services/nativeStateV1.js';
import { MachineServiceNativeRuntimeFactsV1Schema, DeploymentReviewServiceV1Schema } from '../../../local/services/nativeRuntimeFactsV1.js';
export { MachineServiceNativeRuntimeFactsV1Schema, DeploymentReviewServiceV1Schema,
  type MachineServiceNativeRuntimeFactsV1, type DeploymentReviewServiceV1 } from '../../../local/services/nativeRuntimeFactsV1.js';
import { MACHINE_SERVICE_FRONTDOOR_ACTION_IDS } from '../../../local/services/actionIdsV1.js';
import { MachineServiceWatchV1Schema } from '../../../machines/machineServiceWatchesV1.js';
import { MachineDeploymentServiceIdentityV1Schema } from '../../../local/services/serviceIdentityV1.js';
import { HealthCheckStatusV1Schema } from '../../../deployments/healthCheckV1.js';
import { RPC_METHODS } from '../../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';
import { actionInputServerId } from '../definition.js';

export { MACHINE_SERVICE_ACTION_IDS } from '../../../local/services/actionIdsV1.js';
export type MachineServiceActionId = typeof MACHINE_SERVICE_FRONTDOOR_ACTION_IDS[number];
export const MachineServiceActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_SERVICE_FRONTDOOR_ACTION_IDS));
const id = () => z.string().check(z.trim(), z.minLength(1));
const machineTarget = () => ({ serverId: id(), machineId: id() });
const unavailable = lazyZodSchema(() => z.strictObject({ kind: z.literal('unavailable'), reason: ManagedServiceUnavailableReasonV1Schema }));

/** A projection of the canonical admitted handle, never another native observation owner. */
export const MachineServiceRowV1Schema = lazyZodSchema(() => z.strictObject({
  serviceId: id(), name: id(), authority: z.enum(['project', 'machine', 'plugin']),
  lifecyclePurpose: MachineServiceWatchV1Schema.shape.lifecyclePurpose,
  generation: z.nullable(id()), state: z.enum(['starting', 'running', 'detecting', 'healthy', 'unhealthy', 'stopping', 'stopped', 'failed', 'unknown']),
  unavailableReason: z.optional(ManagedServiceUnavailableReasonV1Schema),
  native: z.optional(ManagedServiceNativeStateV1Schema),
  configuration: z.optional(z.nullable(z.pick(DeploymentReviewServiceV1Schema, { ports: true }))),
  health: z.optional(z.strictObject({
    status: HealthCheckStatusV1Schema,
    observedAtMs: MachineServiceNativeRuntimeFactsV1Schema.shape.observedAt,
    freshness: MachineServiceNativeRuntimeFactsV1Schema.shape.freshness,
    reason: z.optional(id()), expectedDown: z.optional(z.literal('stop')),
  })),
  deployment: z.optional(z.strictObject({ deploymentId: id(), installationId: id(), service: MachineDeploymentServiceIdentityV1Schema })),
  nativeInstance: z.optional(z.strictObject({
    adapter: MachineServiceWatchV1Schema.shape.adapter,
    nativeResourceId: MachineServiceWatchV1Schema.shape.nativeResourceId,
  })),
  baseUrl: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  port: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(65535)))),
  capabilities: z.strictObject({ start: z.boolean(), stop: z.boolean(), restart: z.boolean(), logs: z.boolean(), accounting: z.boolean() }),
  environmentId: z.optional(id()), watchId: z.optional(id()), watchRevision: z.optional(id()),
}).check(z.superRefine((row, ctx) => {
  if (row.authority === 'machine' && (!row.watchId || !row.watchRevision)) {
    ctx.addIssue({ code: 'custom', path: ['watchId'], message: 'An adopted service carries its current watch identity and revision.' });
  }
  if (row.deployment && (row.environmentId !== row.deployment.service.environmentId || row.serviceId !== row.deployment.service.serviceId)) {
    ctx.addIssue({ code: 'custom', path: ['deployment'], message: 'The deployment witness belongs to this exact service row.' });
  }
})));
export type MachineServiceRowV1 = z.infer<typeof MachineServiceRowV1Schema>;
export const MachineServiceDiscoveryCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  candidateId: id(), revision: id(), name: id(), adapter: MachineServiceWatchV1Schema.shape.adapter,
  nativeResourceId: MachineServiceWatchV1Schema.shape.nativeResourceId,
  observation: z.extend(ManagedServiceNativeStateV1Schema, { endpoint: z.nullable(z.string()) }),
}));
export type MachineServiceDiscoveryCandidateV1 = z.infer<typeof MachineServiceDiscoveryCandidateV1Schema>;
export const MachineServicesListInputV1Schema = lazyZodSchema(() => z.strictObject({ ...machineTarget(), environmentId: z.optional(id()) }));
export const MachineServicesDiscoveryInputV1Schema = lazyZodSchema(() => z.strictObject({ ...machineTarget(), adapter: z.optional(MachineServiceWatchV1Schema.shape.adapter) }));
export const MachineServicesDetailInputV1Schema = lazyZodSchema(() => z.strictObject({ ...machineTarget(), serviceId: id(), expectedGeneration: z.optional(id()) }));
export const MachineServiceWatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...machineTarget(), candidateId: id(), expectedRevision: id(), lifecyclePurpose: MachineServiceWatchV1Schema.shape.lifecyclePurpose,
}));
export const MachineServiceUnwatchInputV1Schema = lazyZodSchema(() => z.strictObject({ ...machineTarget(), watchId: id(), expectedRevision: id() }));
export type MachineServicesListInputV1 = z.infer<typeof MachineServicesListInputV1Schema>;
export type MachineServicesDiscoveryInputV1 = z.infer<typeof MachineServicesDiscoveryInputV1Schema>;
export type MachineServicesDetailInputV1 = z.infer<typeof MachineServicesDetailInputV1Schema>;
export type MachineServiceWatchInputV1 = z.infer<typeof MachineServiceWatchInputV1Schema>;
export type MachineServiceUnwatchInputV1 = z.infer<typeof MachineServiceUnwatchInputV1Schema>;
export const MachineServicesListResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot'), services: z.array(MachineServiceRowV1Schema) }), unavailable,
]));
export const MachineServicesDiscoveryResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot'), candidates: z.array(MachineServiceDiscoveryCandidateV1Schema),
    failures: z.array(z.strictObject({ adapter: MachineServiceWatchV1Schema.shape.adapter, code: id() })) }), unavailable,
]));
/** One explicitly requested native sample; unknown counters remain null. */
export const MachineServiceAccountingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sample'), samples: z.array(z.strictObject({
    nativeResourceId: id(), cpuPercent: z.nullable(z.number()), memoryBytes: z.nullable(z.number()),
  })) }), unavailable,
]));
export type MachineServiceAccountingV1 = z.infer<typeof MachineServiceAccountingV1Schema>;
export const MachineServicesDetailResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('service'), service: MachineServiceRowV1Schema,
    accounting: z.optional(MachineServiceAccountingV1Schema),
    runtimeFacts: z.optional(MachineServiceNativeRuntimeFactsV1Schema) }), unavailable,
]));
export const MachineServiceWatchMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['applied', 'unchanged', 'conflict']), revision: id(), watch: z.optional(MachineServiceWatchV1Schema) }), unavailable,
]));
export type MachineServicesListResultV1 = z.infer<typeof MachineServicesListResultV1Schema>;
export type MachineServicesDiscoveryResultV1 = z.infer<typeof MachineServicesDiscoveryResultV1Schema>;
export type MachineServicesDetailResultV1 = z.infer<typeof MachineServicesDetailResultV1Schema>;
export type MachineServiceWatchMutationResultV1 = z.infer<typeof MachineServiceWatchMutationResultV1Schema>;
export const MACHINE_SERVICE_ACTION_INPUT_SCHEMAS = {
  'machines.services.list': MachineServicesListInputV1Schema,
  'machines.services.discovery': MachineServicesDiscoveryInputV1Schema,
  'machines.services.detail': MachineServicesDetailInputV1Schema,
  'machines.services.watch': MachineServiceWatchInputV1Schema,
  'machines.services.unwatch': MachineServiceUnwatchInputV1Schema,
} as const;
export const MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS = {
  'machines.services.list': MachineServicesListResultV1Schema,
  'machines.services.discovery': MachineServicesDiscoveryResultV1Schema,
  'machines.services.detail': MachineServicesDetailResultV1Schema,
  'machines.services.watch': MachineServiceWatchMutationResultV1Schema,
  'machines.services.unwatch': MachineServiceWatchMutationResultV1Schema,
} as const;
export type MachineServiceActionInput = z.infer<(typeof MACHINE_SERVICE_ACTION_INPUT_SCHEMAS)[MachineServiceActionId]>;
export type MachineServiceActionOutput = z.infer<(typeof MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS)[MachineServiceActionId]>;
const rpcMethods = {
  'machines.services.list': RPC_METHODS.MACHINES_SERVICE_LIST,
  'machines.services.discovery': RPC_METHODS.MACHINES_SERVICE_DISCOVERY,
  'machines.services.detail': RPC_METHODS.MACHINES_SERVICE_DETAIL,
  'machines.services.watch': RPC_METHODS.MACHINES_SERVICE_WATCH,
  'machines.services.unwatch': RPC_METHODS.MACHINES_SERVICE_UNWATCH,
} as const;
type ServiceActionSpec<Id extends MachineServiceActionId> = Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema'> & {
  id: Id; inputSchema: (typeof MACHINE_SERVICE_ACTION_INPUT_SCHEMAS)[Id]; outputSchema: (typeof MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS)[Id];
};
function serviceSpec<const Id extends MachineServiceActionId>(id: Id, title: string, description: string): ServiceActionSpec<Id> {
  const write = id === 'machines.services.watch' || id === 'machines.services.unwatch';
  return { id, title, description, safety: 'safe', sideEffectClass: write ? 'write' : 'read', approval: { result: 'none' },
    approvalScope: 'machine', executionPlacement: 'machine', placements: [], approvalPolicy: { uiConfirmation: 'direct' },
    toolExposure: { agent: 'discoverable_only' }, surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
    bindings: { rpcMethod: rpcMethods[id], mcpToolName: id.replaceAll('.', '_') },
    inputSchema: MACHINE_SERVICE_ACTION_INPUT_SCHEMAS[id], outputSchema: MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS[id],
    invocationServerIdForInput: actionInputServerId<(typeof MACHINE_SERVICE_ACTION_INPUT_SCHEMAS)[MachineServiceActionId]>(MACHINE_SERVICE_ACTION_INPUT_SCHEMAS[id], input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      ...(id === 'machines.services.discovery' ? [{ path: 'adapter', title: 'Native adapter', widget: 'json' as const }] : []),
      ...(id === 'machines.services.detail' ? [{ path: 'serviceId', title: 'Service ID', widget: 'text' as const, required: true },
        { path: 'expectedGeneration', title: 'Service generation', widget: 'text' as const }] : []),
      ...(id === 'machines.services.watch' ? [{ path: 'candidateId', title: 'Candidate ID', widget: 'text' as const, required: true },
        { path: 'lifecyclePurpose', title: 'Purpose', widget: 'text' as const, required: true }] : []),
      ...(id === 'machines.services.unwatch' ? [{ path: 'watchId', title: 'Watch ID', widget: 'text' as const, required: true }] : []),
      ...(write ? [{ path: 'expectedRevision', title: 'Reviewed revision', widget: 'text' as const, required: true }] : []),
    ] },
  };
}
export const MachineServiceControlInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...machineTarget(), serviceId: id(), expectedGeneration: id(), operation: z.enum(['start', 'stop', 'restart']),
}));
export type MachineServiceControlInputV1 = z.infer<typeof MachineServiceControlInputV1Schema>;
export const MachineServiceControlResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observed'), serviceId: id(), generation: id(),
    state: MachineServiceRowV1Schema.shape.state, operation: z.strictObject({ operationId: id() }) }),
  z.strictObject({ kind: z.literal('accepted'), operation: z.strictObject({ operationId: id() }) }),
  z.strictObject({ kind: z.literal('unsupported'), reason: ManagedServiceUnavailableReasonV1Schema }),
  z.strictObject({ kind: z.literal('outcome_unknown'), operation: z.strictObject({ operationId: id() }) }),
]));
export type MachineServiceControlResultV1 = z.infer<typeof MachineServiceControlResultV1Schema>;
export const MACHINE_SERVICE_ACTION_SPECS = [
  serviceSpec('machines.services.list', 'List Machine services', 'Read the admitted service snapshots from this Machine.'),
  serviceSpec('machines.services.discovery', 'Discover existing services', 'Passively discover native candidates and report partial source failures.'),
  serviceSpec('machines.services.detail', 'Read service detail', 'Read the exact admitted service and its supported capabilities.'),
  serviceSpec('machines.services.watch', 'Watch an existing service', 'Save observation intent for the exact discovered native instance without starting it.'),
  serviceSpec('machines.services.unwatch', 'Stop watching a service', 'Remove observation intent without stopping the native service.'),
{
  id: 'machines.services.control', title: 'Control a service',
  description: 'Start, stop or restart the exact admitted native service generation without recreating it.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'machine', placements: [],
  approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'direct' },
  operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
  toolExposure: { agent: 'discoverable_only' },
  surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  bindings: { mcpToolName: 'machines_services_control', rpcMethod: RPC_METHODS.MACHINES_SERVICE_CONTROL },
  inputSchema: MachineServiceControlInputV1Schema, outputSchema: MachineServiceControlResultV1Schema,
  cli: { acceptsServerId: true, commands: [{ path: ['machines', 'services', 'control'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
    { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
    { path: 'serviceId', title: 'Service ID', widget: 'text', required: true },
    { path: 'expectedGeneration', title: 'Service generation', widget: 'text', required: true },
    { path: 'operation', title: 'Operation', widget: 'text', required: true },
  ] },
},
{
  id: 'machines.services.logs.read', title: 'Read service logs', approval: { result: 'required' },
  description: 'Read a bounded, redacted page from the exact admitted service generation.',
  safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [],
  toolExposure: { agent: 'discoverable_only' },
  surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  bindings: { mcpToolName: 'machine_services_logs_read', rpcMethod: RPC_METHODS.MACHINES_SERVICE_LOGS_READ },
  inputSchema: MachineServiceLogsReadInputV1Schema, outputSchema: ManagedServiceNativeLogResultV1Schema,
  cli: { acceptsServerId: true, commands: [{ path: ['machines', 'services', 'logs', 'read'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
    { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
    { path: 'serviceId', title: 'Service ID', widget: 'text', required: true },
    { path: 'cursor', title: 'Log cursor', widget: 'json' },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
