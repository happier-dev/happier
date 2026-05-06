import { describe, expect, it } from 'vitest';

import { createDirectSessionViewerLeaseRegistry } from './directSessionViewerLeaseRegistry';

describe('createDirectSessionViewerLeaseRegistry', () => {
  it('renews an existing lease id for the same session and detaches it cleanly', () => {
    let nowMs = 1_000;
    const registry = createDirectSessionViewerLeaseRegistry({
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
});
