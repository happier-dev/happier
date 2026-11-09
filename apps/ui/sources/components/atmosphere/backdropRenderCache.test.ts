import { describe, expect, it } from 'vitest';
import { createBackdropRenderCache } from './backdropRenderCache';

describe('backdrop cached rendering', () => {
    it('shares an in-flight render and retains completed pixels for the same key', async () => {
        let started = 0;
        const cache = createBackdropRenderCache(async () => { started += 1; return { pixels: started }; });
        const first = cache.acquire('one');
        const second = cache.acquire('one');
        expect(first.promise).toBe(second.promise);
        expect(await first.promise).toEqual({ pixels: 1 });
        first.release();
        const third = cache.acquire('one');
        expect(await third.promise).toEqual({ pixels: 1 });
        second.release(); third.release();
        const different = cache.acquire('different-size');
        expect(await different.promise).toEqual({ pixels: 2 });
        different.release();
        const next = cache.acquire('one');
        expect(await next.promise).toEqual({ pixels: 3 });
        next.release();
    });
    it('does not keep a failed render, allowing the next visit to recover', async () => {
        let attempts = 0;
        const cache = createBackdropRenderCache(async () => { if (++attempts === 1) throw new Error('image unavailable'); return 'ready'; });
        await expect(cache.acquire('picture').promise).rejects.toThrow('image unavailable');
        const recovered = cache.acquire('picture');
        await expect(recovered.promise).resolves.toBe('ready');
        recovered.release();
    });
    it('cancels pending work only when its last current consumer leaves and admits a fresh value', async () => {
        const signals: AbortSignal[] = [];
        const finish: Array<(value: string) => void> = [];
        const retired: string[] = [];
        const cache = createBackdropRenderCache((_key, signal) => {
            signals.push(signal);
            return new Promise<string>(resolve => { finish.push(resolve); });
        }, value => retired.push(value));
        const first = cache.acquire('picture');
        const second = cache.acquire('picture');
        first.release();
        expect(signals[0].aborted).toBe(false);
        second.release();
        expect(signals[0].aborted).toBe(true);
        const replacement = cache.acquire('picture');
        finish[0]('retired');
        await first.promise;
        expect(retired).toEqual(['retired']);
        const joined = cache.acquire('picture');
        expect(joined.promise).toBe(replacement.promise);
        finish[1]('current');
        await expect(replacement.promise).resolves.toBe('current');
        joined.release(); replacement.release();
        expect(retired).toEqual(['retired', 'current']);
    });
    it('does not let a released render evict its replacement after a worker is remounted', async () => {
        let rejectOld!: (error: Error) => void;
        let finishNew!: (value: string) => void;
        let attempts = 0;
        const cache = createBackdropRenderCache(() => ++attempts === 1
            ? new Promise<string>((_resolve, reject) => { rejectOld = reject; })
            : new Promise<string>(resolve => { finishNew = resolve; }));
        const old = cache.acquire('picture');
        cache.clear();
        const replacement = cache.acquire('picture');
        rejectOld(new Error('worker unmounted'));
        await expect(old.promise).rejects.toThrow('worker unmounted');
        const joined = cache.acquire('picture');
        expect(joined.promise).toBe(replacement.promise);
        finishNew('pixels');
        await expect(replacement.promise).resolves.toBe('pixels');
        old.release(); joined.release(); replacement.release();
    });
});
