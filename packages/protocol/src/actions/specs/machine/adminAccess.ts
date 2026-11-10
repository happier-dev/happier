import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { MachineAdminAccessMutationV1Schema, MachineAdminAccessMutationResultV1Schema,
  MachineAdminAccessInspectResultV1Schema } from '../../../machines/adminAccessV1.js';
import { RPC_METHODS } from '../../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';
import { actionInputServerId } from '../definition.js';
import { MACHINE_ADMIN_ACCESS_ACTION_IDS } from '../../../machines/adminAccessActionIdsV1.js';

export { MACHINE_ADMIN_ACCESS_ACTION_IDS } from '../../../machines/adminAccessActionIdsV1.js';
export type MachineAdminAccessActionId = typeof MACHINE_ADMIN_ACCESS_ACTION_IDS[number];
export const MachineAdminAccessActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_ADMIN_ACCESS_ACTION_IDS));
const target = () => ({ serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineId: z.string().check(z.trim(), z.minLength(1)) });
export const MachineAdminAccessInspectInputV1Schema = lazyZodSchema(() => z.strictObject(target()));
export const MachineAdminAccessSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), ...MachineAdminAccessMutationV1Schema.shape,
}));
export const MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS = {
  'machines.setup.adminAccess.set': MachineAdminAccessSetInputV1Schema,
  'machines.setup.adminAccess.inspect': MachineAdminAccessInspectInputV1Schema,
} as const;
export const MACHINE_ADMIN_ACCESS_ACTION_OUTPUT_SCHEMAS = {
  'machines.setup.adminAccess.set': MachineAdminAccessMutationResultV1Schema,
  'machines.setup.adminAccess.inspect': MachineAdminAccessInspectResultV1Schema,
} as const;
export type MachineAdminAccessActionInput = z.infer<(typeof MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS)[MachineAdminAccessActionId]>;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true } as const;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;
function createMachineAdminAccessActionSpecs() {
  return [
  {
    id: 'machines.setup.adminAccess.set', title: 'Change administrator access',
    permissionChanging: true, approvalScope: 'machine',
    description: 'Save the reviewed administrator policy on the target daemon, then reconcile its host policy.',
    approval: { result: 'required' }, safety: 'danger', sideEffectClass: 'danger',
    approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp', 'plugin'], uiConfirmation: 'policy' },
    executionPlacement: 'machine', placements: [], surfaces,
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
    bindings: { mcpToolName: 'machines_setup_admin_access_set', rpcMethod: RPC_METHODS.MACHINE_ADMIN_ACCESS_SET },
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'setup', 'admin-access', 'set'], visibility: 'canonical' }] },
    inputSchema: MachineAdminAccessSetInputV1Schema, outputSchema: MachineAdminAccessMutationResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineAdminAccessSetInputV1Schema, input => input.serverId),
    inputHints: { fields: [...fields,
      { path: 'expectedMetadataVersion', title: 'Metadata version', widget: 'number', required: true },
      { path: 'expectedAdminAccess', title: 'Reviewed administrator policy', widget: 'json', required: true },
      { path: 'adminAccess', title: 'Administrator policy', widget: 'json', required: true },
      { path: 'comparison', title: 'Comparison', widget: 'text', required: true },
    ] },
  },
  {
    id: 'machines.setup.adminAccess.inspect', title: 'Inspect administrator access',
    description: 'Observe this daemon’s identity, host administrator power and native operator evidence without elevation.',
    approval: { result: 'required' }, safety: 'safe', sideEffectClass: 'read',
    executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_setup_admin_access_inspect', rpcMethod: RPC_METHODS.MACHINE_ADMIN_ACCESS_INSPECT },
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'setup', 'admin-access', 'inspect'], visibility: 'canonical' }] },
    inputSchema: MachineAdminAccessInspectInputV1Schema, outputSchema: MachineAdminAccessInspectResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineAdminAccessInspectInputV1Schema, input => input.serverId),
    inputHints: { fields },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_ADMIN_ACCESS_ACTION_SPECS: ReturnType<typeof createMachineAdminAccessActionSpecs> = lazyActionSpecArray(createMachineAdminAccessActionSpecs);
