import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineGuardPolicyV1Schema } from './guardPolicyV1.js';
import { MachineGuardStateV1Schema } from './guardStateV1.js';
import { GuardKeepReasonV1Schema, MachineGuardLadderV1Schema } from './guardViewV1.js';
import { MachineGuardActivityRowV1Schema, MachineGuardActivityListV1Schema,
  MachineGuardActivityRangeV1Schema, MachineGuardActivityFilterV1Schema } from './activityV1.js';

const count = () => z.number().check(z.int(), z.nonnegative());
const bytes = () => z.number().check(z.nonnegative());
export const MachineGuardViewV1Schema = lazyZodSchema(() => z.strictObject({
  policy: MachineGuardPolicyV1Schema, policyRevision: count(), state: MachineGuardStateV1Schema,
  ladder: MachineGuardLadderV1Schema,
  othersWorkCount: count(),
  idle: z.array(z.strictObject({ sessionRef: z.string().check(z.minLength(1)), title: z.nullable(z.string()), agentId: z.string(),
    status: z.enum(['stops_at', 'kept', 'not_yet']), stopAt: z.optional(bytes()), reason: z.optional(GuardKeepReasonV1Schema), idleMs: bytes(),
  })),
  idleTerminals: z.optional(z.array(z.strictObject({ terminalId: z.string().check(z.minLength(1)), terminalKey: z.string().check(z.minLength(1)), label: z.string(),
    idleMs: bytes(), eligible: z.boolean(), commandRunning: z.nullable(z.boolean()),
    status: z.enum(['eligible', 'stops_at', 'not_yet']), stopAt: z.optional(bytes()),
    reasons: z.array(z.enum(['foreground_unknown', 'finite_work', 'stop_pending', 'native_owner_unknown', 'not_yet', 'warning_unavailable', 'wrong_target'])),
  }))),
  leftBehind: z.strictObject({ count: count(), footprintBytes: z.nullable(bytes()) }),
  keepAwake: z.strictObject({ holding: z.boolean(), workingSessions: count() }),
  managed: z.optional(z.strictObject({ retentionRef: z.string().check(z.minLength(1)) })),
  recentActivity: z.array(MachineGuardActivityRowV1Schema),
  recentActivityOthers: count(),
  // GRD-25: evaluated once at get/watch admission, never on each parked answer.
  otherMemoryGuards: z.optional(z.array(z.enum(['systemd-oomd', 'earlyoom']))),
}));
export type MachineGuardViewV1 = z.infer<typeof MachineGuardViewV1Schema>;
export const MachineGuardGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)), serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export const MachineGuardWatchInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineGuardGetInputV1Schema, { since: z.optional(count()) })));
export type MachineGuardWatchInputV1 = z.infer<typeof MachineGuardWatchInputV1Schema>;
export const MachineGuardWatchResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ changed: z.literal(true), view: MachineGuardViewV1Schema, since: count() }),
  z.strictObject({ changed: z.literal(false) }),
]));
export type MachineGuardWatchResultV1 = z.infer<typeof MachineGuardWatchResultV1Schema>;

/** Activity V1 observation is independent of the Guard planner/census watch. All envelopes are closed. */
export const MachineGuardActivityWatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)), serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  range: MachineGuardActivityRangeV1Schema, filter: z.optional(MachineGuardActivityFilterV1Schema), since: z.optional(count()),
}));
export const MachineGuardActivityWatchResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ changed: z.literal(true), list: MachineGuardActivityListV1Schema, since: count() }),
  z.strictObject({ changed: z.literal(false) }),
]));
export type MachineGuardActivityWatchResultV1 = z.infer<typeof MachineGuardActivityWatchResultV1Schema>;
