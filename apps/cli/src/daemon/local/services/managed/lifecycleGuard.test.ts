import { describe, expect, it } from 'vitest';

import { createLocalServiceLifecycleGuard } from './lifecycleGuard';

describe('createLocalServiceLifecycleGuard', () => {
    it('serializes operations per serviceKey but runs different services in parallel', async () => {
        const guard = createLocalServiceLifecycleGuard();
        const order: string[] = [];
        const makeOp = (label: string, delayMs: number) => async () => {
            order.push(`start:${label}`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            order.push(`end:${label}`);
            return label;
        };

        const sameKey = Promise.all([
            guard.run('svc-a', makeOp('a1', 20)),
            guard.run('svc-a', makeOp('a2', 1)),
        ]);
        const otherKey = guard.run('svc-b', makeOp('b1', 1));
        await Promise.all([sameKey, otherKey]);

        // a1 fully completes before a2 starts (same key serialized).
        expect(order.indexOf('end:a1')).toBeLessThan(order.indexOf('start:a2'));
    });

    it('continues the queue even when an operation rejects', async () => {
        const guard = createLocalServiceLifecycleGuard();
        await expect(guard.run('svc', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(guard.run('svc', async () => 'ok')).resolves.toBe('ok');
    });

    it('tracks a monotonic run-identity stamp per serviceKey', () => {
        const guard = createLocalServiceLifecycleGuard();
        expect(guard.currentRunId('svc')).toBe(0);
        const first = guard.nextRunId('svc');
        const second = guard.nextRunId('svc');
        expect(second).toBeGreaterThan(first);
        expect(guard.isCurrentRun('svc', second)).toBe(true);
        expect(guard.isCurrentRun('svc', first)).toBe(false); // a stale run is no longer current
        guard.forget('svc');
        expect(guard.currentRunId('svc')).toBe(0);
        const restarted = guard.nextRunId('svc');
        expect(restarted).toBeGreaterThan(second);
        expect(guard.isCurrentRun('svc', first)).toBe(false);
    });
});
