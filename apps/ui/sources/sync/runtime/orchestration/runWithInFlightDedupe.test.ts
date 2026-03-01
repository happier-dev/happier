import { describe, expect, it, vi } from 'vitest';
import { runWithInFlightDedupe } from '@/sync/runtime/orchestration/runWithInFlightDedupe';

describe('runWithInFlightDedupe', () => {
    it('dedupes concurrent runs', async () => {
        let inFlight: Promise<void> | null = null;
        let release: () => void = () => {};
        const blocker = new Promise<void>((resolve) => {
            release = () => resolve();
        });

        const task = vi.fn(async () => {
            await blocker;
        });

        const p1 = runWithInFlightDedupe({ get: () => inFlight, set: (value) => { inFlight = value; } }, task);
        const p2 = runWithInFlightDedupe({ get: () => inFlight, set: (value) => { inFlight = value; } }, task);

        expect(task).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([p1, p2]);
    });

    it('allows a new run after completion', async () => {
        let inFlight: Promise<void> | null = null;
        const task = vi.fn(async () => {});

        await runWithInFlightDedupe({ get: () => inFlight, set: (value) => { inFlight = value; } }, task);
        await runWithInFlightDedupe({ get: () => inFlight, set: (value) => { inFlight = value; } }, task);

        expect(task).toHaveBeenCalledTimes(2);
    });
});
