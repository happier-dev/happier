import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationEventAdmitDefinitionSelectorV1Schema } from '../automations/automationEventAdmissionSelectorV1.js';

export const MachinePresenceTransitionKindV1Schema = lazyZodSchema(() => z.enum(['offline', 'online']));
export type MachinePresenceTransitionKindV1 = z.infer<typeof MachinePresenceTransitionKindV1Schema>;

const occurrence = lazyZodSchema(() => z.strictObject({
  revision: z.number().check(z.int(), z.minimum(1)),
  occurredAt: z.number().check(z.int(), z.minimum(0)),
}));
/** Latest occurrence of each polarity, not a historical transition journal. */
export const MachinePresenceTransitionsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), revision: z.number().check(z.int(), z.minimum(1)),
  offline: z.nullable(occurrence), online: z.nullable(occurrence),
}));
export type MachinePresenceTransitionsV1 = z.infer<typeof MachinePresenceTransitionsV1Schema>;
/** Recipient-specific structural candidates; authored definitions stay private.
 * This travels on the existing Account change feed, not a transition journal. */
export const MachinePresenceAutomationOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), serverId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
  transition: MachinePresenceTransitionKindV1Schema,
  ...occurrence.shape,
  definitions: z.array(AutomationEventAdmitDefinitionSelectorV1Schema),
}));
export type MachinePresenceAutomationOccurrenceV1 = z.infer<typeof MachinePresenceAutomationOccurrenceV1Schema>;
export function readMachinePresenceAutomationOccurrenceV1(hint: unknown): MachinePresenceAutomationOccurrenceV1 | null {
  if (hint === null || typeof hint !== 'object' || !('machinePresence' in hint)) return null;
  const parsed = MachinePresenceAutomationOccurrenceV1Schema.safeParse(hint.machinePresence);
  return parsed.success ? parsed.data : null;
}
export const MachinePresenceReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
}));
