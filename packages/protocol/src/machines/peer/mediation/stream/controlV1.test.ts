import { describe, expect, it } from 'vitest';

describe('Machine live-stream control sideband V1', () => {
  it('denies input control when the exclusive source has no active lease', async () => {
    const mod = await import('./controlV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('validateMachineLiveStreamControlLeaseV1');
    if (!('validateMachineLiveStreamControlLeaseV1' in mod)) return;

    const result = mod.validateMachineLiveStreamControlLeaseV1({
      source: {
        sourceId: 'source_1',
        inputMode: 'exclusive',
      },
      control: {
        v: 1,
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'event_1',
        kind: 'tap',
        x: 0.5,
        y: 0.5,
      },
      activeLease: null,
      nowMs: 1_000,
    });

    expect(result).toEqual({
      ok: false,
      reasonCode: 'input_lease_required',
    });
  });

  it('denies input control when a shared source has no active lease', async () => {
    const mod = await import('./controlV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('validateMachineLiveStreamControlLeaseV1');
    if (!('validateMachineLiveStreamControlLeaseV1' in mod)) return;

    const result = mod.validateMachineLiveStreamControlLeaseV1({
      source: {
        sourceId: 'source_1',
        inputMode: 'shared',
      },
      control: {
        v: 1,
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'event_1',
        kind: 'tap',
        x: 0.5,
        y: 0.5,
      },
      activeLease: null,
      nowMs: 1_000,
    });

    expect(result).toEqual({
      ok: false,
      reasonCode: 'input_lease_required',
    });
  });

  it('allows capture controls without an input lease', async () => {
    const mod = await import('./controlV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('validateMachineLiveStreamControlLeaseV1');
    if (!('validateMachineLiveStreamControlLeaseV1' in mod)) return;

    expect(mod.validateMachineLiveStreamControlLeaseV1({
      source: {
        sourceId: 'source_1',
        inputMode: 'exclusive',
      },
      control: {
        v: 1,
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'event_1',
        kind: 'request_keyframe',
      },
      activeLease: null,
      nowMs: 1_000,
    })).toEqual({ ok: true });
  });

  it('requires exclusive input controls to carry the active lease id', async () => {
    const mod = await import('./controlV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('validateMachineLiveStreamControlLeaseV1');
    if (!('validateMachineLiveStreamControlLeaseV1' in mod)) return;

    const source = {
      sourceId: 'source_1',
      inputMode: 'exclusive',
    } as const;
    const activeLease = {
      v: 1,
      leaseId: 'lease_1',
      streamId: 'stream_1',
      sourceId: 'source_1',
      holderId: 'viewer_1',
      mode: 'exclusive',
      acquiredAtMs: 1_000,
      expiresAtMs: 2_000,
    } as const;
    const control = {
      v: 1,
      streamId: 'stream_1',
      sourceId: 'source_1',
      eventId: 'event_1',
      kind: 'tap',
      x: 0.5,
      y: 0.5,
    } as const;

    expect(mod.validateMachineLiveStreamControlLeaseV1({
      source,
      control,
      activeLease,
      nowMs: 1_100,
    })).toEqual({
      ok: false,
      reasonCode: 'input_lease_mismatch',
    });

    expect(mod.validateMachineLiveStreamControlLeaseV1({
      source,
      control: { ...control, leaseId: 'lease_1' },
      activeLease,
      nowMs: 1_100,
    })).toEqual({ ok: true });
  });

  it('rejects untyped fields on sideband input controls', async () => {
    const mod = await import('./controlV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('MachineLiveStreamControlSidebandV1Schema');
    if (!('MachineLiveStreamControlSidebandV1Schema' in mod)) return;

    expect(mod.MachineLiveStreamControlSidebandV1Schema.safeParse({
      v: 1,
      streamId: 'stream_1',
      sourceId: 'source_1',
      eventId: 'event_1',
      leaseId: 'lease_1',
      kind: 'tap',
      x: 0.5,
      y: 0.5,
      payload: { arbitrary: true },
    }).success).toBe(false);
  });
});
