import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { MACHINE_SETUP_PLAN_ACTION_ID_V1 } from '../managed/actionIdsV1.js';
import { MACHINE_REBOOT_ACTION_IDS } from '../rebootActionIdsV1.js';
import { MachineSetupUpdatesObservationV1Schema } from '../setup/machineSetupObservationV1.js';
import { MachineSetupObservationReasonV1Schema } from '../setup/machineSetupObservationReasonV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const count = () => z.number().check(z.int(), z.nonnegative());
const band = () => z.enum(['A', 'B', 'C', 'D', 'F']);
const target = () => z.strictObject({ machineId: id() });
const grade = () => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('graded'), band: band() }),
  z.strictObject({ kind: z.literal('incomplete'), lowerBand: band(), upperBand: band() }),
  z.strictObject({ kind: z.literal('no_applicable_evidence') }),
]);
const repair = () => z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal(MACHINE_SETUP_PLAN_ACTION_ID_V1), target: target(),
    inputHints: z.strictObject({ scope: z.enum(['security', 'all']) }) }),
  z.strictObject({ actionId: z.literal(MACHINE_REBOOT_ACTION_IDS[0]), target: target() }),
]);

export const MachineSecurityInspectInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: id(), serverId: z.optional(id()),
  /** Reuse the owner's settled fact after an update operation has published it. */
  observation: z.optional(z.literal('settled')),
}));

export const MachineSecurityInspectResultV1Schema = lazyZodSchema(() => z.strictObject({
  grade: grade(),
  rows: z.array(z.strictObject({
    check: z.enum(['sshRootCredential', 'sshPassword', 'privateExposure', 'firewall', 'isolation', 'osUpdates', 'rebootRequired']),
    state: z.enum(['pass', 'fail', 'unread', 'inapplicable']),
    reason: z.optional(MachineSetupObservationReasonV1Schema),
    evidence: z.optional(z.strictObject({
      pendingAll: z.optional(count()), pendingSecurity: z.optional(count()), rebootNeeded: z.optional(z.boolean()),
    })),
    repair: z.optional(repair()),
  })),
  updates: MachineSetupUpdatesObservationV1Schema,
}));

export type MachineSecurityInspectResultV1 = z.infer<typeof MachineSecurityInspectResultV1Schema>;
