import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

// Sideband payloads cross a JSON transport. Zod's native JSON schema models
// that recursive wire contract directly and can be faithfully advertised to
// Action-catalog consumers.
const SimulatorJsonValueSchema = lazyZodSchema(() => z.json());

export const SimulatorSidebandKindV1Schema = lazyZodSchema(() => z.enum([
  'accessibility_tree',
  'logs',
  'device_config',
  'app_metadata',
  'network_diagnostics',
  'route',
  'capture_health',
]));

const BaseSimulatorSidebandMessageV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  simulatorId: z.string().check(z.minLength(1)),
  emittedAtMs: NonNegativeIntSchema,
}));

export const SimulatorSidebandMessageV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorSidebandMessageV1Schema, {
    kind: z.literal('accessibility_tree'),
    tree: SimulatorJsonValueSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorSidebandMessageV1Schema, {
    kind: z.literal('logs'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorSidebandMessageV1Schema, {
    kind: z.literal('device_config'),
    config: z.record(z.string(), SimulatorJsonValueSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorSidebandMessageV1Schema, {
    kind: z.literal('app_metadata'),
    metadata: z.record(z.string(), SimulatorJsonValueSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorSidebandMessageV1Schema, {
    kind: z.literal('network_diagnostics'),
    diagnostics: z.record(z.string(), SimulatorJsonValueSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorSidebandMessageV1Schema, {
    kind: z.literal('route'),
    route: z.string(),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorSidebandMessageV1Schema, {
    kind: z.literal('capture_health'),
    status: z.enum(['available', 'starting', 'degraded', 'unavailable']),
    reasonCode: z.optional(z.string().check(z.minLength(1))),
  })),
]));

export type SimulatorSidebandKindV1 = z.infer<typeof SimulatorSidebandKindV1Schema>;
export type SimulatorSidebandMessageV1 = z.infer<typeof SimulatorSidebandMessageV1Schema>;

export function createSimulatorSidebandRateLimiterV1(input: Readonly<{
  minIntervalMs: number;
}>): Readonly<{
  accept: (event: Readonly<{
    simulatorId: string;
    kind: SimulatorSidebandKindV1;
    nowMs: number;
  }>) => Readonly<{ ok: true } | { ok: false; reasonCode: 'sideband_rate_limited' }>;
}> {
  const lastEmissionByKey = new Map<string, number>();
  const minIntervalMs = Math.max(0, Math.floor(input.minIntervalMs));
  return {
    accept: (event) => {
      const key = `${event.simulatorId}:${event.kind}`;
      const lastEmissionAtMs = lastEmissionByKey.get(key);
      if (typeof lastEmissionAtMs === 'number' && event.nowMs - lastEmissionAtMs < minIntervalMs) {
        return { ok: false, reasonCode: 'sideband_rate_limited' };
      }
      lastEmissionByKey.set(key, event.nowMs);
      return { ok: true };
    },
  };
}
