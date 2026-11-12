import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { MACHINE_ROLES_ACTION_IDS } from './machineRolesActionIdsV1.js';
export { MACHINE_ROLES_ACTION_IDS } from './machineRolesActionIdsV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  MachineRolesGetResultV1Schema, MachineRolesListResultV1Schema, MachineRolesMutationResultV1Schema, MachineRolesMutationV1Schema,
} from '../../machines/roles/machineRolesV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';

export type MachineRolesActionId = typeof MACHINE_ROLES_ACTION_IDS[number];
export const MachineRolesActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_ROLES_ACTION_IDS));
export const MachineRolesGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))), machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export const MachineRolesSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineRolesGetInputV1Schema, MachineRolesMutationV1Schema.shape)));
export type MachineRolesSetInputV1 = z.infer<typeof MachineRolesSetInputV1Schema>;
export const MACHINE_ROLES_ACTION_INPUT_SCHEMAS = {
  'machines.roles.list': MachineRolesGetInputV1Schema,
  'machines.roles.get': MachineRolesGetInputV1Schema,
  'machines.roles.set': MachineRolesSetInputV1Schema,
} as const;
export type MachineRolesActionInput = z.infer<(typeof MACHINE_ROLES_ACTION_INPUT_SCHEMAS)[MachineRolesActionId]>;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false } as const;
function createMachineRolesActionSpecs() {
  return [
    {
      id: 'machines.roles.list', approval: { result: 'required' }, title: 'List machine roles',
      toolExposure: { agent: 'discoverable_only' },
      prompting: { agentGuidance: 'Lists what a Machine runs: each built-in and plugin role with whether it is selected and active. A role that needs another role is active only when that role is on. Use it before suggesting a role change or explaining why a Machine refuses work with machine_role_inactive.' },
      description: 'The roles a machine can run and which are on, also while it is offline.',
      safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [], surfaces,
      bindings: { mcpToolName: 'machines_roles_list' },
      inputSchema: MachineRolesGetInputV1Schema, outputSchema: MachineRolesListResultV1Schema,
      invocationServerIdForInput: actionInputServerId(MachineRolesGetInputV1Schema, input => input.serverId),
      cli: { acceptsServerId: true, commands: [{ path: ['machines', 'roles', 'list'], visibility: 'canonical' }] },
      inputHints: { fields },
    },
    {
      id: 'machines.roles.get', approval: { result: 'required' }, title: 'Read machine roles',
      toolExposure: { agent: 'discoverable_only' },
      prompting: { agentGuidance: 'Read the saved role set and its metadataVersion before machines.roles.set. A missing setting means every built-in role is on.' },
      description: 'A machine’s saved role set, also while it is offline.',
      safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [], surfaces,
      bindings: { mcpToolName: 'machines_roles_get' },
      inputSchema: MachineRolesGetInputV1Schema, outputSchema: MachineRolesGetResultV1Schema,
      invocationServerIdForInput: actionInputServerId(MachineRolesGetInputV1Schema, input => input.serverId),
      cli: { acceptsServerId: true, commands: [{ path: ['machines', 'roles', 'get'], visibility: 'canonical' }] },
      inputHints: { fields },
    },
    {
      id: 'machines.roles.set', approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp', 'plugin'] }, approval: { result: 'required' },
      title: 'Change machine roles',
      toolExposure: { agent: 'discoverable_only' },
      prompting: { agentGuidance: 'Read machines.roles.get first, then submit the whole new active set with expectedPolicy and expectedMetadataVersion. Change only the roles the person asked to change. Turning Sessions off lets running Sessions finish and refuses new ones.' },
      description: 'Chooses what a machine runs. Work for a role that is off is refused with machine_role_inactive and is not routed to this machine. Running Sessions keep running until they stop. If the roles changed meanwhile, you see the current ones first.',
      safety: 'safe', sideEffectClass: 'write', executionPlacement: 'machine', placements: [], surfaces: { ...surfaces, rpc: true },
      bindings: { mcpToolName: 'machines_roles_set', rpcMethod: RPC_METHODS.MACHINES_ROLES_SET },
      inputSchema: MachineRolesSetInputV1Schema, outputSchema: MachineRolesMutationResultV1Schema,
      invocationServerIdForInput: actionInputServerId(MachineRolesSetInputV1Schema, input => input.serverId),
      cli: { acceptsServerId: true, commands: [{ path: ['machines', 'roles', 'set'], visibility: 'canonical' }] },
      inputHints: { fields: [...fields,
        { path: 'expectedMetadataVersion', title: 'Expected metadata version', widget: 'number', required: true },
        { path: 'expectedPolicy', title: 'Roles you read', widget: 'json', required: true },
        { path: 'policy', title: 'New roles', widget: 'json', required: true },
      ] },
    },
  ] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_ROLES_ACTION_SPECS: ReturnType<typeof createMachineRolesActionSpecs> = lazyActionSpecArray(createMachineRolesActionSpecs);
