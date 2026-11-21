import type { SupportedLanguages } from '@pierre/diffs';
import { WorkerPoolManager } from '@pierre/diffs/worker';

import { ensureHappierPierreThemesRegistered, HAPPIER_PIERRE_THEME_IDS, type HappierPierreThemeIds } from './pierreThemeRegistry.web';
import { createPierreDiffWorker } from './pierreWorkerFactory.web';
import type { PierreDiffPresentationStyle } from './resolvePierreWorkerPoolConfig';
import { resolvePierreWorkerPoolConfig } from './resolvePierreWorkerPoolConfig';

const PRELOAD_LANGS: SupportedLanguages[] = [
    'typescript',
    'javascript',
    'tsx',
    'jsx',
    'json',
    'markdown',
];

const poolByStyle: Record<PierreDiffPresentationStyle, WorkerPoolManager | null | undefined> = {
    unified: undefined,
    split: undefined,
};

const poolThemeKeyByStyle: Record<PierreDiffPresentationStyle, string | undefined> = {
    unified: undefined,
    split: undefined,
};

const poolListenersByStyle: Record<PierreDiffPresentationStyle, Set<() => void>> = {
    unified: new Set(),
    split: new Set(),
};

export function subscribePierreDiffWorkerPool(style: PierreDiffPresentationStyle, listener: () => void): () => void {
    poolListenersByStyle[style].add(listener);
    return () => { poolListenersByStyle[style].delete(listener); };
}

export function getPierreDiffWorkerPoolFailed(style: PierreDiffPresentationStyle): boolean {
    return poolByStyle[style] === null;
}

function failWorkerPool(style: PierreDiffPresentationStyle, error: unknown): void {
    if (getPierreDiffWorkerPoolFailed(style)) return;
    const failedPool = poolByStyle[style];
    poolByStyle[style] = null;
    poolThemeKeyByStyle[style] = undefined;
    failedPool?.terminate();
    console.debug(`[pierre] ${style} worker pool failed; using Happier renderer`, error);
    for (const listener of poolListenersByStyle[style]) listener();
}

function resolveWorkerPoolThemeIds(themeIds: HappierPierreThemeIds | undefined): HappierPierreThemeIds {
    return themeIds ?? HAPPIER_PIERRE_THEME_IDS;
}

function buildWorkerPoolThemeKey(themeIds: HappierPierreThemeIds): string {
    return `${themeIds.light}::${themeIds.dark}`;
}

export function getPierreDiffWorkerPool(params?: Readonly<{ style?: PierreDiffPresentationStyle; themeIds?: HappierPierreThemeIds }>): WorkerPoolManager | null {
    if (typeof window === 'undefined') return null;
    if (typeof requestAnimationFrame !== 'function') return null;
    const style: PierreDiffPresentationStyle = params?.style ?? 'split';
    const themeIds = resolveWorkerPoolThemeIds(params?.themeIds);
    const themeKey = buildWorkerPoolThemeKey(themeIds);
    const config = resolvePierreWorkerPoolConfig(style);
    const existingPool = poolByStyle[style];
    if (existingPool !== undefined) {
        if (existingPool && poolThemeKeyByStyle[style] !== themeKey) {
            poolThemeKeyByStyle[style] = themeKey;
            // Viewers ask for the pool while rendering, and re-theming redraws every mounted diff, whose
            // post-render callbacks set React state: apply it once that render has finished.
            queueMicrotask(() => {
                if (poolThemeKeyByStyle[style] !== themeKey || poolByStyle[style] !== existingPool) return;
                void existingPool.setRenderOptions({
                    theme: {
                        light: themeIds.light,
                        dark: themeIds.dark,
                    },
                    lineDiffType: config.defaultLineDiffType,
                }).catch(() => {
                    if (poolThemeKeyByStyle[style] === themeKey) {
                        poolThemeKeyByStyle[style] = undefined;
                    }
                });
            });
        }
        return existingPool ?? null;
    }

    ensureHappierPierreThemesRegistered();

    try {
        // Fail-closed: ensure we can construct a module worker before booting the pool.
        // WorkerPoolManager initializes asynchronously; without this preflight, failures can surface
        // as unhandled rejections in some environments.
        const probe = createPierreDiffWorker();
        probe.terminate();

        const created = new WorkerPoolManager(
            {
                workerFactory: createPierreDiffWorker,
                // Worker errors/termination own failure. A busy renderer is not a failed worker.
                // The package patch makes zero opt out of its arbitrary initialization deadline.
                workerInitializationTimeout: 0,
                poolSize: config.poolSize,
                totalASTLRUCacheSize: config.totalASTLRUCacheSize,
                onWorkerError: (event) => {
                    event.preventDefault();
                    failWorkerPool(style, event);
                },
            },
            {
                theme: {
                    light: themeIds.light,
                    dark: themeIds.dark,
                },
                langs: PRELOAD_LANGS,
                lineDiffType: config.defaultLineDiffType,
                preferredHighlighter: 'shiki-wasm',
            },
        );

        poolByStyle[style] = created;
        poolThemeKeyByStyle[style] = themeKey;
        void created.initialize().then(() => {
            for (const listener of poolListenersByStyle[style]) listener();
        }).catch((error: unknown) => failWorkerPool(style, error));
        return created;
    } catch (error) {
        failWorkerPool(style, error);
        return null;
    }
}
