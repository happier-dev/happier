import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineGuardActivityWayBackV1Schema } from './activityV1.js';

export const GuardKeepReasonV1Schema = z.enum(['working', 'waiting_for_you', 'subagents_running', 'unsent_draft',
  'draft_unknown', 'not_resumable', 'kill_protected', 'activity_unknown', 'kept_running', 'identity_changed',
  'ownership_unknown', 'not_happier', 'footprint_unknown', 'browser_in_use', 'connections_unknown', 'visitors', 'unsupported_target', 'stop_failed']);
export type GuardKeepReasonV1 = z.infer<typeof GuardKeepReasonV1Schema>;
// These closed requester-filtered projections contain no executable process authority.
export const MachineGuardLadderCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  ref: z.string().check(z.minLength(1)),
  /** The census process identity (pid + birth), the same ref the Processes census and stop Actions use. */
  processRef: z.optional(z.string().check(z.minLength(1))),
  kind: z.enum(['browser', 'service', 'session']), label: z.nullable(z.string()), qualifier: z.string(),
  footprintBytes: z.number().check(z.nonnegative()), wayBack: z.optional(z.array(MachineGuardActivityWayBackV1Schema)),
}));
export const MachineGuardLadderV1Schema = lazyZodSchema(() => z.strictObject({
  steps: z.array(z.strictObject({ rung: z.enum(['browsers', 'devServers', 'idleSessions']), enabled: z.boolean(),
    status: z.enum(['next', 'skip', 'off', 'run', 'done']), freesAboutBytes: z.number().check(z.nonnegative()),
    candidates: z.array(MachineGuardLadderCandidateV1Schema),
  })),
  excluded: z.array(z.strictObject({ ref: z.string().check(z.minLength(1)), processRef: z.optional(z.string().check(z.minLength(1))), kind: z.enum(['browser', 'service', 'session']),
    label: z.nullable(z.string()), reason: GuardKeepReasonV1Schema, footprintBytes: z.nullable(z.number().check(z.nonnegative())),
  })),
  summary: z.strictObject({ candidatesBytes: z.number().check(z.nonnegative()), inUseBytes: z.number().check(z.nonnegative()),
    workingBytes: z.number().check(z.nonnegative()), workingSessions: z.number().check(z.int(), z.nonnegative()),
    notHappiersBytes: z.number().check(z.nonnegative()), leftAloneSessions: z.number().check(z.int(), z.nonnegative()),
  }),
}));
export type MachineGuardLadderV1 = z.infer<typeof MachineGuardLadderV1Schema>;
