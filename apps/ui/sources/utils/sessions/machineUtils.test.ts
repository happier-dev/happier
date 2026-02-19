import { describe, expect, it } from 'vitest';

import { isMachineOnline } from './machineUtils';

describe('isMachineOnline', () => {
  it('treats machines as online within the grace window even when active=false', () => {
    const previous = process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS;
    process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS = '10000';
    try {
      const nowMs = 100_000;
      const machine = {
        id: 'm1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: nowMs - 5_000,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      };

      expect(isMachineOnline(machine as any, nowMs)).toBe(true);
      expect(isMachineOnline({ ...machine, activeAt: nowMs - 15_000 } as any, nowMs)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS;
      else process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS = previous;
    }
  });

  it('treats active machines as online regardless of activeAt', () => {
    const machine = {
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
    expect(isMachineOnline(machine as any, 123)).toBe(true);
  });

  it('treats revoked machines as offline', () => {
    const nowMs = 123;
    const machine = {
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
