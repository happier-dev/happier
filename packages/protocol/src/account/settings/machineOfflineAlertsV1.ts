import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Account-owned explicit enrollment; empty means no machine offline alerts. */
export const MachineOfflineAlertsV1Schema = lazyZodSchema(() => z.strictObject({
  machineIds: z.array(z.string().check(z.trim(), z.minLength(1))),
}));
export type MachineOfflineAlertsV1 = z.infer<typeof MachineOfflineAlertsV1Schema>;
export const DEFAULT_MACHINE_OFFLINE_ALERTS_V1: MachineOfflineAlertsV1 = { machineIds: [] };
