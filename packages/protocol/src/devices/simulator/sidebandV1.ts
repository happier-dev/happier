import { z } from 'zod';

const NonNegativeIntSchema = z.number().int().nonnegative();

// Sideband payloads cross a JSON transport. Zod's native JSON schema models
// that recursive wire contract directly and can be faithfully advertised to
// Action-catalog consumers.
const SimulatorJsonValueSchema = z.json();

export const SimulatorSidebandKindV1Schema = z.enum([
  'accessibility_tree',
  'logs',
  'device_config',
  'app_metadata',
  'network_diagnostics',
  'route',
  'capture_health',
]);

const BaseSimulatorSidebandMessageV1Schema = z.object({
  v: z.literal(1),
  simulatorId: z.string().min(1),
  emittedAtMs: NonNegativeIntSchema,
});

export const SimulatorSidebandMessageV1Schema = z.discriminatedUnion('kind', [
  BaseSimulatorSidebandMessageV1Schema.extend({
    kind: z.literal('accessibility_tree'),
    tree: SimulatorJsonValueSchema,
  }).strict(),
  BaseSimulatorSidebandMessageV1Schema.extend({
    kind: z.literal('logs'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  }).strict(),
  BaseSimulatorSidebandMessageV1Schema.extend({
    kind: z.literal('device_config'),
    config: z.record(z.string(), SimulatorJsonValueSchema),
  }).strict(),
  BaseSimulatorSidebandMessageV1Schema.extend({
    kind: z.literal('app_metadata'),
    metadata: z.record(z.string(), SimulatorJsonValueSchema),
  }).strict(),
  BaseSimulatorSidebandMessageV1Schema.extend({
    kind: z.literal('network_diagnostics'),
    diagnostics: z.record(z.string(), SimulatorJsonValueSchema),
  }).strict(),
  BaseSimulatorSidebandMessageV1Schema.extend({
    kind: z.literal('route'),
    route: z.string(),
  }).strict(),
  BaseSimulatorSidebandMessageV1Schema.extend({
    kind: z.literal('capture_health'),
    status: z.enum(['available', 'starting', 'degraded', 'unavailable']),
    reasonCode: z.string().min(1).optional(),
  }).strict(),
]);

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
