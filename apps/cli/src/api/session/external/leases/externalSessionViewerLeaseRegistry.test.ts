import { describe, expect, it } from 'vitest';

import { createExternalSessionViewerLeaseRegistry } from './externalSessionViewerLeaseRegistry';

describe('createExternalSessionViewerLeaseRegistry', () => {
  it('renews an existing lease id for the same session and detaches it cleanly', () => {
    let nowMs = 1_000;
    const registry = createExternalSessionViewerLeaseRegistry({
      now: () => nowMs,
      randomId: () => 'lease-generated',
    });

    const initial = registry.attach({
      sessionId: 'session-1',
      ttlMs: 30_000,
    });

    expect(initial).toEqual({
      leaseId: 'lease-generated',
      expiresAtMs: 31_000,
      renewed: false,
    });

    nowMs = 5_000;
    const renewed = registry.attach({
      sessionId: 'session-1',
      leaseId: 'lease-generated',
      ttlMs: 30_000,
    });

    expect(renewed).toEqual({
      leaseId: 'lease-generated',
      expiresAtMs: 35_000,
      renewed: true,
    });
    expect(registry.countActiveLeases('session-1')).toBe(1);
    expect(registry.detach({ sessionId: 'session-1', leaseId: 'lease-generated' })).toEqual({ detached: true });
    expect(registry.countActiveLeases('session-1')).toBe(0);
  });

  it('bounds distinct active leases per session while allowing renewal at capacity', () => {
    const registry = createExternalSessionViewerLeaseRegistry({
      now: () => 1_000,
    });

    for (let index = 0; index < 64; index += 1) {
      expect(registry.attach({
        sessionId: 'session-bounded',
        leaseId: `lease-${index}`,
        ttlMs: 30_000,
      })).toEqual({
        leaseId: `lease-${index}`,
        expiresAtMs: 31_000,
        renewed: false,
      });
    }

    expect(registry.countActiveLeases('session-bounded')).toBe(64);
    expect(() => registry.attach({
      sessionId: 'session-bounded',
      leaseId: 'lease-over-capacity',
      ttlMs: 30_000,
    })).toThrowError(expect.objectContaining({
      name: 'ExternalSessionViewerLeaseCapacityExceededError',
    }));
    expect(registry.attach({
      sessionId: 'session-bounded',
      leaseId: 'lease-0',
      ttlMs: 60_000,
    })).toEqual({
      leaseId: 'lease-0',
      expiresAtMs: 61_000,
      renewed: true,
    });
    expect(registry.countActiveLeases('session-bounded')).toBe(64);
  });

  it('releases capacity when a lease is detached or expires', () => {
    let nowMs = 1_000;
    const registry = createExternalSessionViewerLeaseRegistry({
      now: () => nowMs,
    });

    for (let index = 0; index < 64; index += 1) {
      registry.attach({
        sessionId: 'session-releases-capacity',
        leaseId: `lease-${index}`,
        ttlMs: index === 0 ? 1_000 : 30_000,
      });
    }

    expect(registry.detach({
      sessionId: 'session-releases-capacity',
      leaseId: 'lease-1',
    })).toEqual({ detached: true });
    expect(() => registry.attach({
      sessionId: 'session-releases-capacity',
      leaseId: 'lease-after-detach',
      ttlMs: 30_000,
    })).not.toThrow();
    expect(registry.countActiveLeases('session-releases-capacity')).toBe(64);

    nowMs = 2_000;
    expect(() => registry.attach({
      sessionId: 'session-releases-capacity',
      leaseId: 'lease-after-expiry',
      ttlMs: 30_000,
    })).not.toThrow();
    expect(registry.countActiveLeases('session-releases-capacity')).toBe(64);
  });
});
