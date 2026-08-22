import { describe, expect, it } from 'vitest';

import { createPluginInvocationLifetime } from './lifetime';

describe('plugin invocation lifetime', () => {
    it('separates context settlement from diagnostic cleanup and completes idempotently', () => {
        const lifetime = createPluginInvocationLifetime();
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
