import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createPendingSnapshotRefreshFloor,
    PENDING_SNAPSHOT_REFRESH_FLOOR_MS,
} from './pendingSnapshotRefreshFloor';

describe('createPendingSnapshotRefreshFloor', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('collapses a reconcile burst into one run per floor window and lands the burst with a trailing run', async () => {
        const reconcile = vi.fn(async () => {});
        const floor = createPendingSnapshotRefreshFloor();

        for (let trigger = 0; trigger < 10; trigger += 1) {
            await floor.sample('s-floor-burst', reconcile);
        }
        expect(reconcile).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(PENDING_SNAPSHOT_REFRESH_FLOOR_MS + 100);
        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('runs a reconcile immediately once the floor window has fully elapsed', async () => {
        const reconcile = vi.fn(async () => {});
        const floor = createPendingSnapshotRefreshFloor();

        await floor.sample('s-floor-elapsed', reconcile);
        await vi.advanceTimersByTimeAsync(PENDING_SNAPSHOT_REFRESH_FLOOR_MS);

        await floor.sample('s-floor-elapsed', reconcile);
        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('keeps the floor per session', async () => {
        const reconcile = vi.fn(async () => {});
        const floor = createPendingSnapshotRefreshFloor();

        await floor.sample('s-floor-a', reconcile);
        await floor.sample('s-floor-a', reconcile);
        await floor.sample('s-floor-b', reconcile);
        expect(reconcile).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(PENDING_SNAPSHOT_REFRESH_FLOOR_MS + 100);
        expect(reconcile).toHaveBeenCalledTimes(3);
    });

    it('surfaces a rejected trailing reconcile as a tagged error, not a bare unhandled rejection', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const reconcile = vi.fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('owner route failed'));
            const floor = createPendingSnapshotRefreshFloor();

            await floor.sample('s-floor-reject', reconcile);
            await floor.sample('s-floor-reject', reconcile);

            await vi.advanceTimersByTimeAsync(PENDING_SNAPSHOT_REFRESH_FLOOR_MS + 100);
            expect(reconcile).toHaveBeenCalledTimes(2);
            expect(consoleError).toHaveBeenCalledWith(
                '[fireAndForget] pendingSnapshotRefreshFloor.trailingReconcile',
                expect.any(Error),
            );
        } finally {
            consoleError.mockRestore();
        }
    });
});
