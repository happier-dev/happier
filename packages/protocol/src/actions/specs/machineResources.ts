import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { MACHINE_RESOURCES_ACTION_IDS } from './machineResourcesActionIdsV1.js';
export { MACHINE_RESOURCES_ACTION_IDS } from './machineResourcesActionIdsV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineResourcesPolicyMutationV1Schema, MachineResourcesPolicyGetResultV1Schema, MachineResourcesPolicyMutationResultV1Schema } from '../../machines/resources/machineResourcesPolicyV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
export type MachineResourcesActionId = typeof MACHINE_RESOURCES_ACTION_IDS[number];
export const MachineResourcesActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_RESOURCES_ACTION_IDS));
export const MachineResourcesPolicyGetInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: z.optional(z.string().check(z.trim(), z.minLength(1))), machineId: z.string().check(z.trim(), z.minLength(1)) }));
export const MachineResourcesPolicySetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineResourcesPolicyGetInputV1Schema, MachineResourcesPolicyMutationV1Schema.shape)));
const policySetCliFields = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineResourcesPolicySetInputV1Schema, {
  patch: z.optional(MachineResourcesPolicyMutationV1Schema.shape.patch), allProcessesVisible: z.optional(z.boolean()),
})));
export const MachineResourcesPolicySetCliInputV1Schema = lazyZodSchema(() => policySetCliFields.check(z.refine(input => (input.patch === undefined) !== (input.allProcessesVisible === undefined), 'Supply either a policy patch or the All processes choice')));
export function bindMachineResourcesPolicySetCliInput(value: unknown): unknown {
  // The compiler may combine these caller flags with canonical whole-input JSON.
  const { allProcessesVisible, ...input } = lazyZodSchema(() => z.partial(policySetCliFields)).parse(value);
  return allProcessesVisible === undefined ? input : { ...input, patch: { processes: { allProcessesVisible } } };
}
export const MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS = {
  'machines.resources.policy.get': MachineResourcesPolicyGetInputV1Schema,
  'machines.resources.policy.set': MachineResourcesPolicySetInputV1Schema,
} as const;
export type MachineResourcesActionInput = z.infer<(typeof MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS)[MachineResourcesActionId]>;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false } as const;
function createMachineResourcesActionSpecs() {
  return [
  {
    id: 'machines.resources.policy.get', approval: {result: 'required'}, title: 'Read resource settings',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read the synced policy and its revision before suggesting a change. The policy remains readable offline; writing requires the target daemon.' },
    description: 'A machine’s alerts, guard and cleanup settings, also while it is offline.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_resources_policy_get', voiceClientToolName: 'getMachineResourcesPolicy' },
    inputSchema: MachineResourcesPolicyGetInputV1Schema, outputSchema: MachineResourcesPolicyGetResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineResourcesPolicyGetInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'resources', 'policy', 'get'], visibility: 'canonical' }] },
    inputHints: { fields },
  },
  {
    id: 'machines.resources.policy.set', approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp', 'plugin'] }, approval: {result: 'required'}, title: 'Change resource settings',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read machines.resources.policy.get first, then submit one minimal patch with its expectedRevision. Change only the policy the person asked to change; approval follows this Action’s own user setting.' },
    description: 'Changes a machine’s alerts, guard, monitoring and cleanup settings. Monitoring’s read interval applies only while someone watches Live or Overview; otherwise the machine reads once a minute. If they changed meanwhile, you see the current ones first.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'machine', placements: [], surfaces: { ...surfaces, voice: false, rpc: true },
    bindings: { mcpToolName: 'machines_resources_policy_set', rpcMethod: RPC_METHODS.MACHINES_RESOURCES_POLICY_SET },
    inputSchema: MachineResourcesPolicySetInputV1Schema, outputSchema: MachineResourcesPolicyMutationResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineResourcesPolicySetInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [
      { path: ['machines', 'resources', 'policy', 'set'], visibility: 'canonical' },
      { path: ['machines', 'processes', 'all'], visibility: 'alias' },
    ], inputSchema: MachineResourcesPolicySetCliInputV1Schema, bindInput: bindMachineResourcesPolicySetCliInput,
      inputHints: { fields: [...fields,
        { path: 'expectedRevision', title: 'Expected revision', widget: 'number', required: true },
        { path: 'patch', title: 'Policy patch', widget: 'json' },
        { path: 'allProcessesVisible', title: 'Show all processes', widget: 'boolean' },
      ] } },
    inputHints: { fields: [...fields, { path: 'expectedRevision', title: 'Expected revision', widget: 'number', required: true }, { path: 'patch', title: 'Policy patch', widget: 'json', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_RESOURCES_ACTION_SPECS: ReturnType<typeof createMachineResourcesActionSpecs> = lazyActionSpecArray(createMachineResourcesActionSpecs);
