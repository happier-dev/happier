import { describe, expect, it } from 'vitest';

describe('Simulator sideband protocol V1', () => {
  it('validates typed sideband messages and rejects untyped blobs', async () => {
    const mod = await import('./sidebandV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('SimulatorSidebandMessageV1Schema');
    if (!('SimulatorSidebandMessageV1Schema' in mod)) return;

    expect(mod.SimulatorSidebandMessageV1Schema.safeParse({
      v: 1,
      simulatorId: 'sim_1',
      emittedAtMs: 1_000,
      kind: 'logs',
      level: 'info',
      message: 'Booted',
    }).success).toBe(true);
    expect(mod.SimulatorSidebandMessageV1Schema.safeParse({
      v: 1,
      simulatorId: 'sim_1',
      emittedAtMs: 1_000,
      kind: 'debug_blob',
      payload: { arbitrary: true },
    }).success).toBe(false);
    expect(mod.SimulatorSidebandMessageV1Schema.safeParse({
      v: 1,
      simulatorId: 'sim_1',
      emittedAtMs: 1_000,
      kind: 'logs',
      level: 'info',
      message: 'Booted',
      payload: { arbitrary: true },
    }).success).toBe(false);
    expect(mod.SimulatorSidebandMessageV1Schema.safeParse({
      v: 1,
      simulatorId: 'sim_1',
      emittedAtMs: 1_000,
      kind: 'device_config',
      config: { onReady: () => true },
    }).success).toBe(false);
  });

  it('rate limits sideband emissions by kind', async () => {
    const mod = await import('./sidebandV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('createSimulatorSidebandRateLimiterV1');
    if (!('createSimulatorSidebandRateLimiterV1' in mod)) return;

    const limiter = mod.createSimulatorSidebandRateLimiterV1({ minIntervalMs: 500 });
    expect(limiter.accept({ simulatorId: 'sim_1', kind: 'logs', nowMs: 1_000 })).toEqual({ ok: true });
    expect(limiter.accept({ simulatorId: 'sim_1', kind: 'logs', nowMs: 1_100 })).toEqual({
      ok: false,
      reasonCode: 'sideband_rate_limited',
    });
    expect(limiter.accept({ simulatorId: 'sim_1', kind: 'logs', nowMs: 1_500 })).toEqual({ ok: true });
  });
});
