import { describe, expect, it } from 'vitest';

import { createPluginInvocationLifetime } from './lifetime';

describe('plugin invocation lifetime', () => {
    it('awaits retained private credential cleanup before completing an invocation', async () => {
        const lifetime = createPluginInvocationLifetime();
        let release!: () => void;
        const cleanup = new Promise<void>(resolve => { release = resolve; });
        let cleaned = false;
        lifetime.retainCleanup({ dispose: async () => { await cleanup; cleaned = true; } });
        let completed = false;
        const completion = lifetime.complete().then(() => { completed = true; });
        await Promise.resolve();
        expect(lifetime.signal.aborted).toBe(true);
        expect(completed).toBe(false);
        expect(cleaned).toBe(false);
        release();
        await completion;
        expect(cleaned).toBe(true);
        await lifetime.complete();
    });

    it('separates context settlement from diagnostic cleanup and completes idempotently', () => {
        const beforeAdmission = Date.now();
        const lifetime = createPluginInvocationLifetime();
        expect(lifetime.invokedAtMs).toBeGreaterThanOrEqual(beforeAdmission);
        expect(lifetime.invokedAtMs).toBeLessThanOrEqual(Date.now());
        lifetime.settleContext();
        expect(lifetime.signal.aborted).toBe(true);
        expect(lifetime.redactionLifetimeSignal.aborted).toBe(false);
        lifetime.complete();
        lifetime.complete();
        expect(lifetime.redactionLifetimeSignal.aborted).toBe(true);
    });

    it('propagates parent revocation to both lifetimes', () => {
        const parent = new AbortController();
        const lifetime = createPluginInvocationLifetime(parent.signal);
        parent.abort(new Error('retired'));
        expect(lifetime.signal.aborted).toBe(true);
        expect(lifetime.redactionLifetimeSignal.aborted).toBe(true);
    });
});
