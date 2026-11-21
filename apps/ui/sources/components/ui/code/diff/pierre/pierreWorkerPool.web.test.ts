import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { BrowserWorker } from './pierreWorkerTestHelpers';

const pools: WorkerPoolManager[] = [];

beforeEach(() => {
    vi.resetModules();
    BrowserWorker.reset();
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    vi.stubGlobal('document', { baseURI: 'http://localhost/' });
    vi.stubGlobal('Worker', BrowserWorker);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
    vi.useRealTimers();
    for (const pool of pools.splice(0)) pool.terminate();
    // Let the manager's final animation-frame broadcast finish while its browser
    // clock boundary is still installed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('getPierreDiffWorkerPool', () => {
    it('allows healthy worker initialization beyond the former ten-second cutoff', async () => {
        BrowserWorker.holdInitialization = true;
        const owner = await import('./pierreWorkerPool.web');
        vi.useFakeTimers();
        const pool = owner.getPierreDiffWorkerPool({ style: 'unified' });
        if (!pool) throw new Error('Expected a pool');
        pools.push(pool);
        let failure: unknown;
        const initialized = pool.initialize().catch(error => { failure = error; });
        await vi.waitFor(() => expect(BrowserWorker.pendingInitializations.length).toBeGreaterThan(0));
        await vi.advanceTimersByTimeAsync(10_001);
        expect(failure).toBeUndefined();
        expect(owner.getPierreDiffWorkerPoolFailed('unified')).toBe(false);
        for (const respond of BrowserWorker.pendingInitializations.splice(0)) respond();
        await initialized;
        expect(owner.getPierreDiffWorkerPool({ style: 'unified' })).toBe(pool);
    });
    it('returns null and logs once when the browser cannot construct a worker', async () => {
        BrowserWorker.successfulConstructionsBeforeFailure = 0;
        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');

        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(console.debug).toHaveBeenCalledTimes(1);
        expect(console.debug).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'worker disabled' }));
    });

    it('fails the pool if worker construction fails during asynchronous initialization', async () => {
        BrowserWorker.successfulConstructionsBeforeFailure = 1;
        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');
        const pool = getPierreDiffWorkerPool({ style: 'unified' });
        if (!pool) throw new Error('Expected the preflight to succeed');
        pools.push(pool);

        await expect(pool.initialize()).rejects.toThrow('worker disabled');
        await Promise.resolve();

        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(console.debug).toHaveBeenCalledTimes(1);
    });

    it('fails only the affected style after a worker error and releases its workers', async () => {
        const owner = await import('./pierreWorkerPool.web');
        const unified = owner.getPierreDiffWorkerPool({ style: 'unified' });
        if (!unified) throw new Error('Expected a unified pool');
        pools.push(unified);
        await unified.initialize();
        const worker = BrowserWorker.instances.find((candidate) => !candidate.terminated);
        if (!worker) throw new Error('Expected a live unified worker');
        const split = owner.getPierreDiffWorkerPool({ style: 'split' });
        if (!split) throw new Error('Expected a split pool');
        pools.push(split);
        await split.initialize();
        const unifiedChanged = vi.fn();
        const splitChanged = vi.fn();
        const unsubscribeUnified = owner.subscribePierreDiffWorkerPool('unified', unifiedChanged);
        const unsubscribeSplit = owner.subscribePierreDiffWorkerPool('split', splitChanged);

        const event = new Event('error', { cancelable: true });
        worker.dispatchEvent(event);

        expect(owner.getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(owner.getPierreDiffWorkerPool({ style: 'split' })).toBe(split);
        expect(owner.getPierreDiffWorkerPoolFailed('unified')).toBe(true);
        expect(owner.getPierreDiffWorkerPoolFailed('split')).toBe(false);
        expect(unifiedChanged).toHaveBeenCalledTimes(1);
        expect(splitChanged).not.toHaveBeenCalled();
        expect(worker.terminated).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        worker.dispatchEvent(new Event('error'));
        expect(console.debug).toHaveBeenCalledTimes(1);
        expect(unifiedChanged).toHaveBeenCalledTimes(1);
        unsubscribeUnified();
        unsubscribeSplit();
    });

    it('reuses a style pool when the effective theme changes', async () => {
        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');
        const { ensureHappierPierreThemeRegistered, resolveHappierPierreThemeIds } = await import('./pierreThemeRegistry.web');
        const pool = getPierreDiffWorkerPool({ style: 'split' });
        if (!pool) throw new Error('Expected a split pool');
        pools.push(pool);
        await pool.initialize();
        const colors = { text: { primary: '#123456' } };
        ensureHappierPierreThemeRegistered({ isDark: false, colors });
        const themeIds = resolveHappierPierreThemeIds({ isDark: false, colors });

        expect(getPierreDiffWorkerPool({ style: 'split', themeIds })).toBe(pool);
        await vi.waitFor(() => expect(pool.getDiffRenderOptions().theme).toEqual(themeIds));
    });

    it('re-themes mounted diffs after the reading render that asked for it, never inside it', async () => {
        // A viewer reads its pool while rendering. Re-theming redraws every mounted diff, whose post-render
        // callbacks set React state: inside that render, React reports "Cannot update a component while rendering".
        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');
        const { ensureHappierPierreThemeRegistered, resolveHappierPierreThemeIds } = await import('./pierreThemeRegistry.web');
        const pool = getPierreDiffWorkerPool({ style: 'unified' });
        if (!pool) throw new Error('Expected a unified pool');
        pools.push(pool);
        await pool.initialize();
        const setRenderOptions = vi.spyOn(pool, 'setRenderOptions');
        const colors = { text: { primary: '#654321' } };
        ensureHappierPierreThemeRegistered({ isDark: true, colors });
        const themeIds = resolveHappierPierreThemeIds({ isDark: true, colors });

        expect(getPierreDiffWorkerPool({ style: 'unified', themeIds })).toBe(pool);
        expect(setRenderOptions).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(setRenderOptions).toHaveBeenCalledTimes(1);
        // Several viewers reading the same new theme in one render re-theme once.
        getPierreDiffWorkerPool({ style: 'unified', themeIds });
        await Promise.resolve();
        expect(setRenderOptions).toHaveBeenCalledTimes(1);
    });
});
