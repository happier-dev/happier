import { z } from '../../zodRuntimePolicy.js';
import { ActionIdSchema } from '../../actions/actionIds.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { RequesterWorkAttributionV1Schema } from '../requesterWorkAttributionV1.js';
import { SpawnFailureV1Schema } from '../processes/spawnFailureV1.js';
import { SessionGuardMemoryObservationV1Schema } from './sessionGuardStateV1.js';

export const MACHINE_GUARD_ACTIVITY_KINDS_V1 = ['stopped_session', 'closed_browser', 'stopped_service',
  'stopped_left_behind', 'out_of_steps', 'stop_failed', 'kept_running', 'ceiling_near', 'ceiling_reached',
  'system_oom_kill', 'trash_moved', 'trash_emptied', 'closed_terminal', 'housekeeping', 'start_failed', 'undone'] as const;
export const MACHINE_GUARD_ACTIVITY_RULES_V1 = ['memory_guard', 'idle_sessions', 'left_behind', 'ceiling',
  'system', 'approved_proposal', 'idle_terminals', 'housekeeping'] as const;
const id = () => z.string().check(z.minLength(1));
const bytes = () => z.number().check(z.nonnegative());
const count = () => z.number().check(z.int(), z.nonnegative());

// Executable references are closed. Their JSON input is retained data, not admission:
// the original Action must validate it and enforce its own approval before any effect.
export const MachineGuardActivityWayBackV1Schema = lazyZodSchema(() => z.strictObject({
  label: z.enum(['resume', 'start_again', 'reopen', 'undo', 'empty_now', 'raise_ceiling', 'review_processes']),
  actionId: ActionIdSchema, input: StrictJsonValueSchema,
}));
export const MachineGuardActivityEntryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), id: id(), at: bytes(), kind: z.enum(MACHINE_GUARD_ACTIVITY_KINDS_V1),
  rule: z.enum(MACHINE_GUARD_ACTIVITY_RULES_V1),
  subject: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('session'), sessionId: id(), title: z.nullable(z.string()) }),
    z.strictObject({ kind: z.literal('browser') }),
    z.strictObject({ kind: z.literal('service'), label: z.string(), port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65535))) }),
    z.strictObject({ kind: z.literal('processes'), count: count() }),
    z.strictObject({ kind: z.literal('trash'), items: count() }),
    z.strictObject({ kind: z.literal('terminal'), terminalKey: id(), label: z.string(), idleMs: bytes() }),
    z.strictObject({ kind: z.literal('housekeeping'), logs: z.optional(count()), recordings: z.optional(count()), trashEntries: z.optional(count()) }),
  ])),
  trigger: z.optional(z.strictObject({ level: z.enum(['elevated', 'critical']), sinceMs: bytes(),
    inUseBytes: z.optional(bytes()), swapBytes: z.optional(bytes()) })),
  step: z.optional(z.union([z.literal(1), z.literal(2), z.literal(3)])), episodeId: z.optional(id()),
  freedBytes: z.optional(bytes()), inTrashBytes: z.optional(bytes()),
  memory: z.optional(SessionGuardMemoryObservationV1Schema),
  outcome: z.enum(['done', 'failed', 'did_not_help']), note: z.optional(z.string()),
  wayBack: z.optional(z.array(MachineGuardActivityWayBackV1Schema).check(z.minLength(1))), ref: z.optional(id()),
  attribution: z.union([RequesterWorkAttributionV1Schema, z.strictObject({ kind: z.literal('unknown') })]),
  failure: z.optional(SpawnFailureV1Schema), nextStep: z.optional(z.enum(['close_idle_terminals', 'review_processes'])),
}).check(z.superRefine((entry, context) => {
  if (entry.kind === 'undone' && !entry.ref) context.addIssue({ code: 'custom', path: ['ref'], message: 'Undone requires the original entry ID' });
  if (entry.kind === 'start_failed' && (!entry.failure || !entry.nextStep)) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Failed starts require a typed cause and next step' });
  }
})));
export type MachineGuardActivityEntryV1 = z.infer<typeof MachineGuardActivityEntryV1Schema>;
export type MachineGuardActivityWayBackV1 = z.infer<typeof MachineGuardActivityWayBackV1Schema>;

export function isMachineGuardRestorationWayBackV1(item: MachineGuardActivityWayBackV1): boolean {
  return ['resume', 'start_again', 'reopen', 'undo'].includes(item.label);
}

// Presentation receipts are additive-open/drop on stored read; known fields stay strict.
export const MachineGuardActivityStoredReadV1Schema = createStoredReadSchema(MachineGuardActivityEntryV1Schema);
export const MachineGuardActivityRowV1Schema = lazyZodSchema(() => z.safeExtend(MachineGuardActivityEntryV1Schema, { undoneAt: z.optional(bytes()) }));
export type MachineGuardActivityRowV1 = z.infer<typeof MachineGuardActivityRowV1Schema>;
export const MachineGuardActivityRangeV1Schema = z.enum(['today', '7d', '30d']);
export const MachineGuardActivityFilterV1Schema = z.enum(['all', 'stopped', 'cleaned_up', 'needs_look']);
export const MachineGuardActivityListV1Schema = lazyZodSchema(() => z.strictObject({
  entries: z.array(MachineGuardActivityRowV1Schema),
  counts: z.strictObject({ stopped: count(), cleanedUp: count(), needsLook: count(), others: count() }),
  asOf: bytes(),
}));
export type MachineGuardActivityListV1 = z.infer<typeof MachineGuardActivityListV1Schema>;

export function isGuardActionEntry(entry: MachineGuardActivityEntryV1): entry is MachineGuardActivityEntryV1 & {
  kind: 'stopped_session' | 'closed_browser' | 'stopped_service' | 'stopped_left_behind';
  rule: 'memory_guard' | 'idle_sessions' | 'left_behind' | 'ceiling';
} {
  return entry.outcome !== 'failed' && ['stopped_session', 'closed_browser', 'stopped_service', 'stopped_left_behind'].includes(entry.kind)
    && ['memory_guard', 'idle_sessions', 'left_behind', 'ceiling'].includes(entry.rule);
}
