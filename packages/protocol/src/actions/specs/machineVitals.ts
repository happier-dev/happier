import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { MACHINE_VITALS_ACTION_IDS } from './machineVitalsActionIdsV1.js';
export { MACHINE_VITALS_ACTION_IDS } from './machineVitalsActionIdsV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineVitalsGetInputV1Schema, MachineVitalsHistoryGetInputV1Schema, MachineVitalsSnapshotV1Schema } from '../../machines/vitals/machineVitalsRpcV1.js';
import { MachineVitalsHistoryV1Schema } from '../../machines/vitals/machineVitalsHistoryV1.js';
import { MachineResourceAttentionV1Schema, MachineResourceSummaryV1Schema } from '../../machines/resources/machineResourceSummaryV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
export type MachineVitalsActionId = typeof MACHINE_VITALS_ACTION_IDS[number];
export const MachineVitalsActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_VITALS_ACTION_IDS));
export const MachineVitalsSummariesListInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: z.optional(z.string().check(z.trim(), z.minLength(1))) }));
export const MachineVitalsSummariesListOutputV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  machineId: z.string(), name: z.string(), presence: z.enum(['online', 'offline']),
  state: z.enum(['reporting', 'unavailable', 'not_reporting', 'offline']),
  attention: z.optional(MachineResourceAttentionV1Schema),
  summary: z.optional(MachineResourceSummaryV1Schema),
})));
export const MACHINE_VITALS_ACTION_INPUT_SCHEMAS = {
  'machines.vitals.get': MachineVitalsGetInputV1Schema,
  'machines.vitals.history.get': MachineVitalsHistoryGetInputV1Schema,
  'machines.vitals.summaries.list': MachineVitalsSummariesListInputV1Schema,
} as const;
export type MachineVitalsActionInput = z.infer<(typeof MACHINE_VITALS_ACTION_INPUT_SCHEMAS)[MachineVitalsActionId]>;
const fields = [
  { path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false } as const;
const read = { safety: 'safe', sideEffectClass: 'read', placements: [], surfaces } as const;
function createMachineVitalsActionSpecs() {
  return [
  {
    ...read, id: 'machines.vitals.get', approval: {result: 'required'}, title: 'Read machine vitals',
    toolExposure: { agent: 'direct' },
    prompting: { agentGuidance: 'Read current vitals before diagnosing resource use. Unknown metrics are not zero. For memory pressure, read machines.processes.list and machines.guard.get; the Guard ladder is the canonical source of stop candidates.' },
    description: 'CPU, memory pressure, disk and network of a machine, now and over the last five minutes.',
    executionPlacement: 'machine',
    bindings: { mcpToolName: 'machines_vitals_get', voiceClientToolName: 'getMachineVitals', rpcMethod: RPC_METHODS.MACHINES_VITALS_GET },
    inputSchema: MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.get'], outputSchema: MachineVitalsSnapshotV1Schema,
    invocationServerIdForInput: actionInputServerId(MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.get'], input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'vitals', 'get'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'view', title: 'View', widget: 'select', options: [{ value: 'summary', label: 'Summary' }, { value: 'overview', label: 'Overview' }] }] },
  },
  {
    ...read, id: 'machines.vitals.history.get', approval: {result: 'required'}, title: 'Read machine vitals history',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Use machine-local history to explain changes over time; distinguish past samples from current facts before proposing an effect.' },
    description: 'How CPU, memory, disk and network changed over the last hour, day or week.', executionPlacement: 'machine',
    surfaces: { ...surfaces, voice: false },
    bindings: { mcpToolName: 'machines_vitals_history_get', rpcMethod: RPC_METHODS.MACHINES_VITALS_HISTORY_GET },
    inputSchema: MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.history.get'], outputSchema: MachineVitalsHistoryV1Schema,
    invocationServerIdForInput: actionInputServerId(MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.history.get'], input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'vitals', 'history', 'get'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'serviceId', title: 'Service ID', widget: 'text' }, { path: 'range', title: 'History range', widget: 'select', required: true, options: [{ value: '1h', label: '1 hour' }, { value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }] }] },
  },
  {
    ...read, id: 'machines.vitals.summaries.list', approval: {result: 'required'}, title: 'Read every machine at a glance',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Use this fleet read to choose which machine needs attention; offline or unavailable machines are not calm and have no current sample.' },
    description: 'A short summary of every machine: which need a look, and which are offline or not reporting.',
    executionPlacement: 'account', bindings: { mcpToolName: 'machines_vitals_summaries_list', voiceClientToolName: 'listMachineVitalsSummaries' },
    inputSchema: MachineVitalsSummariesListInputV1Schema, outputSchema: MachineVitalsSummariesListOutputV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineVitalsSummariesListInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'vitals', 'summaries', 'list'], visibility: 'canonical' }] },
    inputHints: { fields: [fields[0]] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_VITALS_ACTION_SPECS: ReturnType<typeof createMachineVitalsActionSpecs> = lazyActionSpecArray(createMachineVitalsActionSpecs);
