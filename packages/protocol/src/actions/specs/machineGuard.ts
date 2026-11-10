import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MACHINE_GUARD_ACTION_IDS } from '../../machines/guard/actionIdsV1.js';
import { MachineGuardGetInputV1Schema, MachineGuardViewV1Schema } from '../../machines/guard/guardRpcV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { MACHINE_GUARD_ACTIVITY_ACTION_SPECS, MACHINE_GUARD_ACTIVITY_INPUT_SCHEMAS, MACHINE_GUARD_ACTIVITY_OUTPUT_SCHEMAS } from './machineGuardActivity.js';
import type { ApprovalPresentationContext, PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
export { MACHINE_GUARD_ACTION_IDS } from '../../machines/guard/actionIdsV1.js';
export type { MachineGuardActionId } from '../../machines/guard/actionIdsV1.js';
export const MachineGuardActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_GUARD_ACTION_IDS));
export const MachineGuardKeepRunningInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineGuardGetInputV1Schema, {
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))), terminalKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
})).check(z.refine((input) => Boolean(input.sessionId) !== Boolean(input.terminalKey), { message: 'Exactly one session or terminal target is required' })));
export const MachineGuardKeepRunningResultV1Schema = z.strictObject({ status: z.enum(['kept', 'not_pending']) });
export const MachineGuardSessionCeilingSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineGuardGetInputV1Schema, {
  sessionId: z.string().check(z.trim(), z.minLength(1)), bytes: z.nullable(z.number().check(z.int(), z.positive())),
})));
export const MachineGuardSessionCeilingSetResultV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), appliesAt: z.enum(['now', 'next_start']) }),
  z.strictObject({ status: z.literal('unavailable'), appliesAt: z.enum(['now', 'next_start']),
    reason: z.enum(['not_linux', 'no_user_manager', 'no_memory_controller']) }),
]);
export type MachineGuardSessionCeilingSetResultV1 = z.infer<typeof MachineGuardSessionCeilingSetResultV1Schema>;
export const MACHINE_GUARD_ACTION_INPUT_SCHEMAS = {
  'machines.guard.get': MachineGuardGetInputV1Schema,
  ...MACHINE_GUARD_ACTIVITY_INPUT_SCHEMAS,
  'machines.guard.idleStop.keepRunning': MachineGuardKeepRunningInputV1Schema,
  'machines.guard.sessionCeiling.set': MachineGuardSessionCeilingSetInputV1Schema,
} as const;
export const MACHINE_GUARD_ACTION_OUTPUT_SCHEMAS = {
  'machines.guard.get': MachineGuardViewV1Schema,
  ...MACHINE_GUARD_ACTIVITY_OUTPUT_SCHEMAS,
  'machines.guard.idleStop.keepRunning': MachineGuardKeepRunningResultV1Schema,
  'machines.guard.sessionCeiling.set': MachineGuardSessionCeilingSetResultV1Schema,
} as const;
export type MachineGuardActionInput = z.infer<(typeof MACHINE_GUARD_ACTION_INPUT_SCHEMAS)[keyof typeof MACHINE_GUARD_ACTION_INPUT_SCHEMAS]>;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true } as const;
const ceilingReviewFields = [
  ...fields, { path: 'sessionId', title: 'Session', widget: 'text', required: true },
  { path: 'ceiling', title: 'Ceiling', widget: 'text', required: true },
  { path: 'room', title: 'Room', widget: 'text', required: true },
  { path: 'ifReached', title: 'If reached', widget: 'text', required: true },
  { path: 'bytes', title: 'Ceiling bytes', widget: 'json' },
] as const;
function presentSessionCeiling(input: unknown, context?: ApprovalPresentationContext) {
  const value = MachineGuardSessionCeilingSetInputV1Schema.parse(input);
  const memory = context?.machineMemory?.machineId === value.machineId ? context.machineMemory : undefined;
  const format = (bytes: number) => context?.formatDataBytes?.(bytes, { kind: 'memory' }) ?? 'Not reported';
  return { ...value,
    ceiling: value.bytes === null ? 'No ceiling' : format(value.bytes),
    room: memory?.availableBytes != null && memory.totalBytes != null
      ? `${format(memory.availableBytes)} free of ${format(memory.totalBytes)}` : 'Not reported',
    ifReached: value.bytes === null ? 'No session memory ceiling will be enforced.'
      : 'The session stops where it can resume. Send another message to continue.',
  };
}
function createMachineGuardActionSpecs() {
  return [
  { id: 'machines.guard.get', approval: {result: 'required'}, title: 'Read the guard', description: 'What the guard watches on a machine, and what it would stop first if memory ran short.',
    toolExposure: { agent: 'direct' },
    prompting: { agentGuidance: 'Use this planner’s live ladder as the canonical source of stop candidates, sizes and why-not reasons. Explain what Guard would do without inventing a second process-selection heuristic.' },
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_guard_get', rpcMethod: RPC_METHODS.MACHINES_GUARD_GET },
    inputSchema: MachineGuardGetInputV1Schema, outputSchema: MachineGuardViewV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineGuardGetInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'guard', 'get'], visibility: 'canonical' }] }, inputHints: { fields } },
  ...MACHINE_GUARD_ACTIVITY_ACTION_SPECS,
  { id: 'machines.guard.idleStop.keepRunning', approval: {result: 'required'}, title: 'Keep this work running', description: 'Cancels a pending automatic stop and keeps this work running. Guard settings stay as they are.',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read machines.guard.get first, then keep the named session or terminal running when requested. This cancels its current stop warning; it does not change the policy.' },
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_guard_idle_stop_keep_running', rpcMethod: RPC_METHODS.MACHINES_GUARD_IDLE_STOP_KEEP_RUNNING },
    inputSchema: MachineGuardKeepRunningInputV1Schema, outputSchema: MachineGuardKeepRunningResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineGuardKeepRunningInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'guard', 'idle-stop', 'keep-running'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'sessionId', title: 'Session ID', widget: 'text' }, { path: 'terminalKey', title: 'Terminal key', widget: 'text' }] } },
  { id: 'machines.guard.sessionCeiling.set', approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp', 'plugin'] }, approval: {result: 'required'}, title: 'Change this session’s memory ceiling',
    approvalPresentation: {
      summary: (input: unknown) => MachineGuardSessionCeilingSetInputV1Schema.safeParse(input).data?.bytes === null
        ? 'Remove this session’s memory ceiling.' : 'Change how much memory this session can use.',
      technicalInputPaths: ['bytes'], projectInput: presentSessionCeiling,
      inputSchema: lazyZodSchema(() => z.extend(MachineGuardSessionCeilingSetInputV1Schema, {
        ceiling: z.string(), room: z.string(), ifReached: z.string(),
      })),
      inputHints: { fields: ceilingReviewFields },
    },
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read machines.guard.get and machines.vitals.get first. If this session reached its Linux ceiling, explain the current ceiling and available room, then request the new bytes or null through this Action’s existing approval fields. Approval follows its own user setting; report now versus next-start application and unavailable platforms.' },
    description: 'On Linux, limits how much memory this session can use, now or from its next start.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_guard_session_ceiling_set', rpcMethod: RPC_METHODS.MACHINES_GUARD_SESSION_CEILING_SET },
    inputSchema: MachineGuardSessionCeilingSetInputV1Schema, outputSchema: MachineGuardSessionCeilingSetResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineGuardSessionCeilingSetInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'guard', 'session-ceiling', 'set'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields, { path: 'sessionId', title: 'Session ID', widget: 'text', required: true },
      { path: 'bytes', title: 'Ceiling bytes (null for no ceiling)', widget: 'json', required: true }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_GUARD_ACTION_SPECS: ReturnType<typeof createMachineGuardActionSpecs> = lazyActionSpecArray(createMachineGuardActionSpecs);
