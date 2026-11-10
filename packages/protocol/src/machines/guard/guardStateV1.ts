import * as z from '../../zodRuntimePolicy.js';
import { lazyDefinition } from '../../lazyZodSchema.js';

const at = () => z.number().check(z.gte(0));
export const MachineGuardEpisodeV1Schema = lazyDefinition(() => z.strictObject({
  state: z.enum(['sustaining', 'acting', 'verifying', 'out_of_steps']),
  step: z.optional(z.union([z.literal(1), z.literal(2), z.literal(3)])), since: at(), expectedReturnBytes: z.optional(at()),
}));
export type MachineGuardEpisodeV1 = z.infer<typeof MachineGuardEpisodeV1Schema>;
export const MachineGuardStateV1Schema = lazyDefinition(() => z.strictObject({
  v: z.literal(1), capabilities: z.strictObject({
    memoryPressure: z.union([z.strictObject({ status: z.literal('available') }),
      z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['no_pressure_signal', 'sampler_unavailable']) })]),
    ceiling: z.union([z.strictObject({ status: z.literal('available') }),
      z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['not_linux', 'no_user_manager', 'no_memory_controller']) })]),
    keepAwake: z.strictObject({ modes: z.array(z.enum(['off', 'on', 'on_power'])), unavailableReason: z.optional(z.enum(['no_inhibitor', 'helper_missing'])) }),
  }), episode: z.optional(MachineGuardEpisodeV1Schema), keepAwakeHolding: z.boolean(),
}));
export type MachineGuardStateV1 = z.infer<typeof MachineGuardStateV1Schema>;
