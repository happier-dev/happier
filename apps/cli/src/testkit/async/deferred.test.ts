import { describe, expect, it } from 'vitest';

describe('createDeferred', () => {
    it('resolves and rejects the exposed promise pair', async () => {
        const mod = await import('./deferred');
        const deferred = mod.createDeferred<number>();

        deferred.resolve(42);

        await expect(deferred.promise).resolves.toBe(42);
    });
});
