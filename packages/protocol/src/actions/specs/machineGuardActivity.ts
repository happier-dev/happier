import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { MachineGuardActivityFilterV1Schema, MachineGuardActivityListV1Schema, MachineGuardActivityRangeV1Schema } from '../../machines/guard/activityV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';

import { MACHINE_GUARD_ACTIVITY_ACTION_IDS } from '../../machines/guard/actionIdsV1.js';
export { MACHINE_GUARD_ACTIVITY_ACTION_IDS } from '../../machines/guard/actionIdsV1.js';
export type MachineGuardActivityActionId = typeof MACHINE_GUARD_ACTIVITY_ACTION_IDS[number];
export const MachineGuardActivityActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_GUARD_ACTIVITY_ACTION_IDS));
const routing = { serverId: z.optional(z.string().check(z.trim(), z.minLength(1))), machineId: z.string().check(z.trim(), z.minLength(1)) };
export const MachineGuardActivityListInputV1Schema = lazyZodSchema(() => z.strictObject({ ...routing,
  range: MachineGuardActivityRangeV1Schema, filter: z.optional(MachineGuardActivityFilterV1Schema),
}));
export const MachineGuardActivityUndoInputV1Schema = lazyZodSchema(() => z.strictObject({ ...routing, entryId: z.string().check(z.trim(), z.minLength(1)) }));
export const MACHINE_GUARD_ACTIVITY_INPUT_SCHEMAS = {
  'machines.guard.activity.list': MachineGuardActivityListInputV1Schema,
  'machines.guard.activity.undo': MachineGuardActivityUndoInputV1Schema,
} as const;
export const MACHINE_GUARD_ACTIVITY_OUTPUT_SCHEMAS = {
  'machines.guard.activity.list': MachineGuardActivityListV1Schema,
  // The original owner's typed result is validated by that Action, not replaced by a generic success receipt.
  'machines.guard.activity.undo': StrictJsonValueSchema,
} as const;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true } as const;
function createMachineGuardActivityActionSpecs() {
  return [
  {
    id: 'machines.guard.activity.list', approval: {result: 'required'}, title: 'Read guard activity',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read these receipts to explain what Happier actually did. Memory can be freed by stopping work; storage remains in Trash until emptied.' },
    description: 'What Happier did by itself, and why. On a shared machine you see your own lines and a count of the rest.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_guard_activity_list', rpcMethod: 'machines.guard.activity.list' },
    inputSchema: MachineGuardActivityListInputV1Schema, outputSchema: MachineGuardActivityListV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineGuardActivityListInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'guard', 'activity', 'list'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'range', title: 'Range', widget: 'select', required: true,
      options: [{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }] },
      { path: 'filter', title: 'Filter', widget: 'select', options: [{ value: 'all', label: 'All' }, { value: 'stopped', label: 'Stopped' },
        { value: 'cleaned_up', label: 'Cleaned up' }, { value: 'needs_look', label: 'Needs a look' }] }] },
  },
  {
    id: 'machines.guard.activity.undo', approval: {result: 'required'}, title: 'Undo an automatic action',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read machines.guard.activity.list first, then undo the requested receipt through its recorded way back. Use this owner rather than reconstructing an inverse operation.' },
    description: 'Starts again, reopens, resumes or puts back from Trash. It asks first whenever the original action would.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_guard_activity_undo', rpcMethod: 'machines.guard.activity.undo' },
    inputSchema: MachineGuardActivityUndoInputV1Schema, outputSchema: StrictJsonValueSchema,
    invocationServerIdForInput: actionInputServerId(MachineGuardActivityUndoInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'guard', 'activity', 'undo'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'entryId', title: 'Activity entry ID', widget: 'text', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_GUARD_ACTIVITY_ACTION_SPECS: ReturnType<typeof createMachineGuardActivityActionSpecs> = lazyActionSpecArray(createMachineGuardActivityActionSpecs);
