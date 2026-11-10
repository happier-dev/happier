import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const duration = () => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
const idleRule = () => z.strictObject({ enabled: z._default(z.boolean(), false), afterMs: z._default(duration().check(z.minimum(60_000)), 7_200_000),
  warnBeforeMs: z._default(duration(), 300_000) });
export const MachineGuardPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  memoryGuard: z._default(z.strictObject({ enabled: z._default(z.boolean(), false), actAt: z._default(z.enum(['elevated', 'critical']), 'critical'),
    sustainMs: z._default(duration().check(z.minimum(60_000)), 120_000), cooldownMs: z._default(duration().check(z.minimum(60_000)), 60_000),
    steps: z._default(z.strictObject({ browsers: z._default(z.boolean(), true), devServers: z._default(z.boolean(), true), idleSessions: z._default(z.boolean(), true) }), () => ({ browsers: true, devServers: true, idleSessions: true })),
    pausedUntil: z._default(z.nullable(duration()), null),
  }), () => ({ enabled: false, actAt: 'critical' as const, sustainMs: 120_000, cooldownMs: 60_000,
    steps: { browsers: true, devServers: true, idleSessions: true }, pausedUntil: null })),
  idleSessions: z._default(idleRule(), () => ({ enabled: false, afterMs: 7_200_000, warnBeforeMs: 300_000 })),
  idleTerminals: z._default(idleRule(), () => ({ enabled: false, afterMs: 7_200_000, warnBeforeMs: 300_000 })),
  leftBehind: z._default(z.strictObject({ mode: z._default(z.enum(['off', 'ask', 'automatic']), 'off'), graceMs: z._default(duration(), 0) }), () => ({ mode: 'off' as const, graceMs: 0 })),
  sessionMemoryCeiling: z._default(z.strictObject({ bytes: z._default(z.nullable(z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER))), null),
    warnAtPercent: z._default(z.number().check(z.minimum(1), z.maximum(99)), 90) }), () => ({ bytes: null, warnAtPercent: 90 })),
  keepAwake: z._default(z.enum(['off', 'on', 'on_power']), 'on'),
}).check(z.superRefine((policy, context) => {
  for (const key of ['idleSessions', 'idleTerminals'] as const) {
    if (policy[key].warnBeforeMs >= policy[key].afterMs) context.addIssue({ code: 'custom', path: [key, 'warnBeforeMs'], message: 'Warning must precede the idle deadline' });
  }
})));
export type MachineGuardPolicyV1 = z.infer<typeof MachineGuardPolicyV1Schema>;
export const MachineGuardPolicyPatchV1Schema = lazyZodSchema(() => {
  const full = MachineGuardPolicyV1Schema.shape;
  const idlePatch = () => z.strictObject({ enabled: z.optional(z.boolean()), afterMs: z.optional(duration().check(z.minimum(60_000))), warnBeforeMs: z.optional(duration()) });
  return z.strictObject({
    memoryGuard: z.optional(z.strictObject({ enabled: z.optional(z.boolean()), actAt: z.optional(z.enum(['elevated', 'critical'])),
      sustainMs: z.optional(duration().check(z.minimum(60_000))), cooldownMs: z.optional(duration().check(z.minimum(60_000))), pausedUntil: z.optional(z.nullable(duration())),
      steps: z.optional(z.strictObject({ browsers: z.optional(z.boolean()), devServers: z.optional(z.boolean()), idleSessions: z.optional(z.boolean()) })),
    })),
    idleSessions: z.optional(idlePatch()), idleTerminals: z.optional(idlePatch()),
    leftBehind: z.optional(z.strictObject({ mode: z.optional(z.enum(['off', 'ask', 'automatic'])), graceMs: z.optional(duration()) })),
    sessionMemoryCeiling: z.optional(z.strictObject({ bytes: z.optional(z.nullable(z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)))), warnAtPercent: z.optional(z.number().check(z.minimum(1), z.maximum(99))) })),
    keepAwake: z.optional(full.keepAwake._zod.def.innerType),
  });
});
export type MachineGuardPolicyPatchV1 = z.infer<typeof MachineGuardPolicyPatchV1Schema>;
export function mergeMachineGuardPolicyV1(current: MachineGuardPolicyV1, patch: MachineGuardPolicyPatchV1 | undefined) {
  return { ...current, ...patch,
    memoryGuard: { ...current.memoryGuard, ...patch?.memoryGuard, steps: { ...current.memoryGuard.steps, ...patch?.memoryGuard?.steps } },
    idleSessions: { ...current.idleSessions, ...patch?.idleSessions }, idleTerminals: { ...current.idleTerminals, ...patch?.idleTerminals },
    leftBehind: { ...current.leftBehind, ...patch?.leftBehind }, sessionMemoryCeiling: { ...current.sessionMemoryCeiling, ...patch?.sessionMemoryCeiling },
  };
}
