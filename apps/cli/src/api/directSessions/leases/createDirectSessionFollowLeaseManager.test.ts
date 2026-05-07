import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDirectSessionFollowLeaseManager } from './createDirectSessionFollowLeaseManager';

describe('createDirectSessionFollowLeaseManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires one follow lease for a viewer lease, renews its expiry, and releases it on detach', async () => {
    let nowMs = 1_000;
    const release = vi.fn(async () => {});
    const acquireFollowLease = vi.fn(async () => ({ release }));

    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-1',
    });

    const attached = await manager.attach({
      sessionId: 'session-1',
      ttlMs: 30_000,
      acquireFollowLease,
    });

    expect(attached).toEqual({
      leaseId: 'lease-1',
      expiresAtMs: 31_000,
      renewed: false,
    });
    expect(acquireFollowLease).toHaveBeenCalledTimes(1);

    nowMs = 10_000;
    const renewed = await manager.attach({
      sessionId: 'session-1',
      leaseId: 'lease-1',
      ttlMs: 30_000,
      acquireFollowLease,
    });

    expect(renewed).toEqual({
      leaseId: 'lease-1',
      expiresAtMs: 40_000,
      renewed: true,
    });
    expect(acquireFollowLease).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(release).not.toHaveBeenCalled();

    const detached = await manager.detach({
      sessionId: 'session-1',
      leaseId: 'lease-1',
    });

    expect(detached).toEqual({ detached: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases follow leases automatically when the viewer lease expires', async () => {
    let nowMs = 5_000;
    const release = vi.fn(async () => {});
    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-expiring',
    });

    await manager.attach({
      sessionId: 'session-expiring',
      ttlMs: 2_000,
      acquireFollowLease: async () => ({ release }),
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(release).not.toHaveBeenCalled();

    nowMs = 7_100;
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledTimes(1);
    expect(manager.countActiveLeases('session-expiring')).toBe(0);
  });

  it('releases the attached follow lease on detach and acquires a detached background lease until disabled', async () => {
    let nowMs = 1_000;
    const attachedRelease = vi.fn(async () => {});
    const backgroundRelease = vi.fn(async () => {});
    const acquireAttachedFollowLease = vi.fn(async () => ({ release: attachedRelease }));
    const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-background',
    });

    await manager.attach({
      sessionId: 'session-background',
      ttlMs: 30_000,
      acquireFollowLease: acquireAttachedFollowLease,
    });
    expect(acquireAttachedFollowLease).toHaveBeenCalledTimes(1);

    const backgroundFollow = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-background',
      enabled: true,
      acquireFollowLease: acquireBackgroundFollowLease,
    });

    expect(backgroundFollow).toEqual(expect.objectContaining({ enabled: true, leaseAcquired: false }));
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(0);

    const detached = await manager.detach({
      sessionId: 'session-background',
      leaseId: 'lease-background',
    });

    expect(detached).toEqual({ detached: true });
    expect(attachedRelease).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(1);
    expect(backgroundRelease).toHaveBeenCalledTimes(0);
    expect(manager.countActiveLeases('session-background')).toBe(0);
    expect(manager.hasBackgroundFollowLease('session-background')).toBe(true);

    const disabled = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-background',
      enabled: false,
    });

    expect(disabled).toEqual({ enabled: false, leaseAcquired: false });
    expect(backgroundRelease).toHaveBeenCalledTimes(1);
  });

  it('transitions from attached follow to detached background follow when the viewer lease expires', async () => {
    let nowMs = 1_000;
    const attachedRelease = vi.fn(async () => {});
    const backgroundRelease = vi.fn(async () => {});
    const acquireAttachedFollowLease = vi.fn(async () => ({ release: attachedRelease }));
    const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-expiry-background',
    });

    await manager.attach({
      sessionId: 'session-expiry-background',
      ttlMs: 2_000,
      acquireFollowLease: acquireAttachedFollowLease,
    });
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-expiry-background',
      enabled: true,
      acquireFollowLease: acquireBackgroundFollowLease,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(attachedRelease).not.toHaveBeenCalled();
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(0);

    nowMs = 3_100;
    await vi.advanceTimersByTimeAsync(1);

    expect(attachedRelease).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(1);
    expect(manager.countActiveLeases('session-expiry-background')).toBe(0);
    expect(manager.hasBackgroundFollowLease('session-expiry-background')).toBe(true);

    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-expiry-background',
      enabled: false,
    });
    expect(backgroundRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared background follow lease alive until the last attached viewer detaches', async () => {
    const viewerRelease = vi.fn(async () => {});
    const backgroundRelease = vi.fn(async () => {});
    const acquireViewerFollowLease = vi.fn(async () => ({ release: viewerRelease }));
    const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
    const manager = createDirectSessionFollowLeaseManager({
      randomId: () => 'lease-shared-background',
    });

    const enabled = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-shared-background',
      enabled: true,
      acquireFollowLease: acquireBackgroundFollowLease,
    });
    expect(enabled).toEqual(expect.objectContaining({ enabled: true, leaseAcquired: true }));
    expect(manager.hasBackgroundFollowLease('session-shared-background')).toBe(true);

    await manager.attach({
      sessionId: 'session-shared-background',
      ttlMs: 30_000,
      acquireFollowLease: acquireViewerFollowLease,
    });

    expect(acquireViewerFollowLease).not.toHaveBeenCalled();
    expect(manager.countActiveLeases('session-shared-background')).toBe(1);

    const disabled = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-shared-background',
      enabled: false,
    });
    expect(disabled).toEqual({ enabled: false, leaseAcquired: false });
    expect(backgroundRelease).not.toHaveBeenCalled();

    await manager.detach({
      sessionId: 'session-shared-background',
      leaseId: 'lease-shared-background',
    });

    expect(backgroundRelease).toHaveBeenCalledTimes(1);
    expect(viewerRelease).not.toHaveBeenCalled();
  });
});
