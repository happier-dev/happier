import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineIsolationGetResultV1Schema, MachineIsolationMutationResultV1Schema,
  MachineIsolationMutationV1Schema } from '../../machines/machineIsolationPolicyV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
import { MACHINE_ISOLATION_ACTION_IDS } from './machineIsolationActionIdsV1.js';
export { MACHINE_ISOLATION_ACTION_IDS } from './machineIsolationActionIdsV1.js';

export type MachineIsolationActionId = typeof MACHINE_ISOLATION_ACTION_IDS[number];
export const MachineIsolationActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_ISOLATION_ACTION_IDS));
export const MachineIsolationGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))), machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export const MachineIsolationSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...MachineIsolationGetInputV1Schema.shape, ...MachineIsolationMutationV1Schema.shape,
}));
export type MachineIsolationSetInputV1 = z.infer<typeof MachineIsolationSetInputV1Schema>;
export const MACHINE_ISOLATION_ACTION_INPUT_SCHEMAS = {
  'machines.isolation.get': MachineIsolationGetInputV1Schema,
  'machines.isolation.set': MachineIsolationSetInputV1Schema,
} as const;
export type MachineIsolationActionInput = z.infer<(typeof MACHINE_ISOLATION_ACTION_INPUT_SCHEMAS)[MachineIsolationActionId]>;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false } as const;
function createMachineIsolationActionSpecs() {
  return [{
    id: 'machines.isolation.get', approval: { result: 'required' }, title: 'Read machine isolation',
    description: 'Reads the Machine’s saved sandbox choices and native Agent sandbox preference, including while offline.',
    toolExposure: { agent: 'discoverable_only' },
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_isolation_get' },
    inputSchema: MachineIsolationGetInputV1Schema, outputSchema: MachineIsolationGetResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineIsolationGetInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'isolation', 'get'], visibility: 'canonical' }] },
    inputHints: { fields },
  }, {
    id: 'machines.isolation.set', approval: { result: 'required' },
    approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp', 'plugin'] }, title: 'Change machine isolation',
    description: 'Saves the sandbox choice for Sessions, bots and channels, and automations and workflows. Sandboxes are acquired when work starts.',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read machines.isolation.get first. Submit the complete policy with expectedPolicy and expectedMetadataVersion. Reference saved presets from admitted local provisioners. Update every work-kind reference when removing a configured sandbox.' },
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'machine', placements: [], surfaces: { ...surfaces, rpc: true },
    bindings: { mcpToolName: 'machines_isolation_set', rpcMethod: RPC_METHODS.MACHINES_ISOLATION_SET },
    inputSchema: MachineIsolationSetInputV1Schema, outputSchema: MachineIsolationMutationResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineIsolationSetInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'isolation', 'set'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields,
      { path: 'expectedMetadataVersion', title: 'Expected metadata version', widget: 'number', required: true },
      { path: 'expectedPolicy', title: 'Policy you read', widget: 'json', required: true },
      { path: 'policy', title: 'New policy', widget: 'json', required: true },
    ] },
  }] as const satisfies readonly PreNormalizedActionSpec[];
}
export const MACHINE_ISOLATION_ACTION_SPECS: ReturnType<typeof createMachineIsolationActionSpecs> = lazyActionSpecArray(createMachineIsolationActionSpecs);
