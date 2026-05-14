import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    delete (globalThis as { Worker?: unknown }).Worker;
});

function installBrowserWorkerGlobals(): void {
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { document?: unknown }).document = { baseURI: 'http://localhost/' };
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
}

describe('getPierreDiffWorkerPool', () => {
    it('fails closed (returns null) when workers cannot be constructed', async () => {
        installBrowserWorkerGlobals();
        (globalThis as any).Worker = function Worker() {
            throw new Error('worker disabled');
        } as any;

        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');

        expect(() => getPierreDiffWorkerPool({ style: 'unified' })).not.toThrow();
        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(() => getPierreDiffWorkerPool({ style: 'split' })).not.toThrow();
        expect(getPierreDiffWorkerPool({ style: 'split' })).toBeNull();
    });

    it('initializes render options with effective dynamic theme ids', async () => {
        installBrowserWorkerGlobals();
        const highlighterOptions: unknown[] = [];

        vi.doMock('./pierreWorkerFactory.web', () => ({
            createPierreDiffWorker: () => ({ terminate: vi.fn() }),
        }));
        vi.doMock('./pierreThemeRegistry.web', () => ({
            ensureHappierPierreThemesRegistered: vi.fn(),
            HAPPIER_PIERRE_THEME_IDS: { light: 'happier-light', dark: 'happier-dark' },
        }));
        vi.doMock('@pierre/diffs/worker', () => ({
            WorkerPoolManager: class WorkerPoolManager {
                initialize = vi.fn(async () => {});

                constructor(_poolOptions: unknown, options: unknown) {
                    highlighterOptions.push(options);
                }
            },
        }));

        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');
        const getPoolWithThemeIds = getPierreDiffWorkerPool as unknown as (params: Readonly<{
            style: 'split';
            themeIds: Readonly<{ light: string; dark: string }>;
        }>) => unknown;

        getPoolWithThemeIds({
            style: 'split',
            themeIds: { light: 'happier-light-custom', dark: 'happier-dark-custom' },
        });

        expect(highlighterOptions[0]).toMatchObject({
            theme: {
                light: 'happier-light-custom',
                dark: 'happier-dark-custom',
            },
        });
    });

    it('updates active render options with effective dynamic theme ids', async () => {
        installBrowserWorkerGlobals();
        const setRenderOptionsSpy = vi.fn(async () => {});

        vi.doMock('./pierreWorkerFactory.web', () => ({
            createPierreDiffWorker: () => ({ terminate: vi.fn() }),
        }));
        vi.doMock('./pierreThemeRegistry.web', () => ({
            ensureHappierPierreThemesRegistered: vi.fn(),
            HAPPIER_PIERRE_THEME_IDS: { light: 'happier-light', dark: 'happier-dark' },
        }));
        vi.doMock('@pierre/diffs/worker', () => ({
            WorkerPoolManager: class WorkerPoolManager {
                initialize = vi.fn(async () => {});
                setRenderOptions = setRenderOptionsSpy;
            },
        }));

        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');
        const getPoolWithThemeIds = getPierreDiffWorkerPool as unknown as (params: Readonly<{
            style: 'split';
            themeIds?: Readonly<{ light: string; dark: string }>;
        }>) => unknown;

        getPoolWithThemeIds({ style: 'split' });
        getPoolWithThemeIds({
            style: 'split',
            themeIds: { light: 'happier-light-custom', dark: 'happier-dark-custom' },
        });

        expect(setRenderOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
            theme: {
                light: 'happier-light-custom',
                dark: 'happier-dark-custom',
            },
        }));
    });
});
