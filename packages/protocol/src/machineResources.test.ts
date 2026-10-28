import { describe, expect, it } from 'vitest';

import {
  DaemonResourcesGetResponseSchema,
  MachineResourcesSnapshotSchema,
} from './machineResources.js';

const snapshot = {
  sampledAt: 1729900000000,
  cpu: { usagePercent: 42.5 },
  memory: { totalBytes: 16_000_000_000, usedBytes: 8_000_000_000, usagePercent: 50 },
  disk: {
    path: '/',
    totalBytes: 500_000_000_000,
    availableBytes: 100_000_000_000,
    usedBytes: 400_000_000_000,
    usagePercent: 80,
  },
};

describe('machineResources', () => {
  it('parses snapshot responses with a full cpu/memory/disk sample', () => {
    const parsed = MachineResourcesSnapshotSchema.parse(snapshot);

    expect(parsed.sampledAt).toBe(1729900000000);
    expect(parsed.cpu.usagePercent).toBe(42.5);
    expect(parsed.memory.usagePercent).toBe(50);
    expect(parsed.disk.path).toBe('/');
    expect(parsed.disk.usagePercent).toBe(80);
  });

  it('accepts percentage boundaries at 0 and 100', () => {
    expect(
      MachineResourcesSnapshotSchema.safeParse({
        ...snapshot,
        cpu: { usagePercent: 0 },
        memory: { ...snapshot.memory, usagePercent: 0 },
        disk: { ...snapshot.disk, usagePercent: 0 },
      }).success,
    ).toBe(true);
    expect(
      MachineResourcesSnapshotSchema.safeParse({
        ...snapshot,
        cpu: { usagePercent: 100 },
        memory: { ...snapshot.memory, usagePercent: 100 },
        disk: { ...snapshot.disk, usagePercent: 100 },
      }).success,
    ).toBe(true);
  });

  it('rejects percentages outside the 0-100 range', () => {
    expect(
      MachineResourcesSnapshotSchema.safeParse({
        ...snapshot,
        cpu: { usagePercent: -1 },
      }).success,
    ).toBe(false);
    expect(
      MachineResourcesSnapshotSchema.safeParse({
        ...snapshot,
        memory: { ...snapshot.memory, usagePercent: 100.5 },
      }).success,
    ).toBe(false);
    expect(
      MachineResourcesSnapshotSchema.safeParse({
        ...snapshot,
        disk: { ...snapshot.disk, usagePercent: -0.5 },
      }).success,
    ).toBe(false);
  });

  it('parses successful daemon.resources.get responses', () => {
    const parsed = DaemonResourcesGetResponseSchema.parse({ ok: true, snapshot });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.disk.availableBytes).toBe(100_000_000_000);
    }
  });

  it('parses failed daemon.resources.get responses with an optional error code', () => {
    const parsed = DaemonResourcesGetResponseSchema.parse({
      ok: false,
      error: 'sample failed',
      errorCode: 'resources_sample_failed',
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBe('sample failed');
      expect(parsed.errorCode).toBe('resources_sample_failed');
    }

    expect(
      DaemonResourcesGetResponseSchema.safeParse({ ok: false, error: 'sample failed' }).success,
    ).toBe(true);
  });
});
