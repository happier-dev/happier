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

    it('keeps a background follow lease alive after detach until background follow is disabled', async () => {
        let nowMs = 1_000;
        const release = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const manager = createDirectSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-background',
        });

        await manager.attach({
            sessionId: 'session-background',
            ttlMs: 30_000,
            acquireFollowLease,
        });
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        const backgroundFollow = await manager.setBackgroundFollowEnabled({
            sessionId: 'session-background',
            enabled: true,
            acquireFollowLease,
        });

        expect(backgroundFollow).toEqual(expect.objectContaining({ enabled: true, leaseAcquired: false }));
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await manager.detach({
            sessionId: 'session-background',
            leaseId: 'lease-background',
        });
        expect(release).not.toHaveBeenCalled();
        expect(manager.countActiveLeases('session-background')).toBe(0);

        const disabled = await manager.setBackgroundFollowEnabled({
            sessionId: 'session-background',
            enabled: false,
        });

        expect(disabled).toEqual({ enabled: false, leaseAcquired: false });
        expect(release).toHaveBeenCalledTimes(1);
    });
});
