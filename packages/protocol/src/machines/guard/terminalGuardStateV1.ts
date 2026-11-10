import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** PTY-owner presentation only; clearing the warning removes this field. */
export const TerminalGuardStateV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal('stopping'), rule: z.literal('idle_terminals'),
  stopAt: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export type TerminalGuardStateV1 = z.infer<typeof TerminalGuardStateV1Schema>;
