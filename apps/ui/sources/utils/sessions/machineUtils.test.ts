import { describe, expect, it } from 'vitest';

import { isMachineOnline } from './machineUtils';

function withGraceMs(graceMs: string, fn: () => void): void {
  const previous = process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS;
  process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS = graceMs;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS;
    else process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS = previous;
  }
}

describe('isMachineOnline (Home-owned presence)', () => {
  const negotiated = { presenceProtocolVersion: 1 as const };
  it('uses authoritative pushed active state without a client expiry or grace window', () => {
    const nowMs = 1_000_000;
    expect(isMachineOnline({ ...negotiated, active: true, activeAt: 1 }, nowMs)).toBe(true);
    expect(isMachineOnline({ ...negotiated, active: false, activeAt: nowMs }, nowMs)).toBe(false);
  });
  it('does not let a configured client grace override a pushed offline state', () => {
    withGraceMs('600000', () => {
      const nowMs = 1_000_000;
      const machine = { ...negotiated, active: false, activeAt: nowMs - 450_000 };
      expect(isMachineOnline(machine, nowMs)).toBe(false);
      expect(isMachineOnline({ ...machine, activeAt: nowMs - 600_001 }, nowMs)).toBe(false);
    });
  });

  it('does not resurrect a recently offline Machine when no client override is set', () => {
    withGraceMs('', () => {
      const nowMs = 100_000;
      const machine = { ...negotiated,
        id: 'm1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: nowMs - 45_000,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      };

      expect(isMachineOnline(machine, nowMs)).toBe(false);
      expect(isMachineOnline({ ...machine, activeAt: nowMs - 65_000 }, nowMs)).toBe(false);
    });
  });

  it('treats active machines as online even when grace is disabled', () => {
    withGraceMs('0', () => {
      const nowMs = 100_000;
      const machine = { ...negotiated,
        id: 'm1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      };

      expect(isMachineOnline(machine as any, nowMs)).toBe(true);
    });
  });

  it('treats pushed inactive Machines as offline regardless of their heartbeat timestamp', () => {
    withGraceMs('10000', () => {
      const nowMs = 100_000;
      const machine = { ...negotiated,
        id: 'm1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: nowMs - 5_000,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      };

      expect(isMachineOnline(machine, nowMs)).toBe(false);
      expect(isMachineOnline({ ...machine, activeAt: nowMs - 15_000 } as any, nowMs)).toBe(false);
    });
  });

  it('keeps pushed active Machines online regardless of their heartbeat timestamp', () => {
    withGraceMs('10000', () => {
      const nowMs = 100_000;
      const machine = { ...negotiated,
        id: 'm1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: nowMs - 15_000,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      };

      expect(isMachineOnline(machine, nowMs)).toBe(true);
    });
  });

  it('treats revoked machines as offline', () => {
    const nowMs = 123;
    const machine = { ...negotiated,
      id: 'm1',
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      active: true,
      activeAt: nowMs,
      revokedAt: nowMs,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };
    expect(isMachineOnline(machine as any, nowMs)).toBe(false);
  });
});
