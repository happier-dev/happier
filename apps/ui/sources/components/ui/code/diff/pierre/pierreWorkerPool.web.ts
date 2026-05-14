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

let pool: WorkerPoolManager | null | undefined;

const poolByStyle: Record<PierreDiffPresentationStyle, WorkerPoolManager | null | undefined> = {
    unified: undefined,
    split: undefined,
};

const poolThemeKeyByStyle: Record<PierreDiffPresentationStyle, string | undefined> = {
    unified: undefined,
    split: undefined,
};

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
            const setRenderOptions = (existingPool as { setRenderOptions?: (options: unknown) => Promise<void> }).setRenderOptions;
            if (typeof setRenderOptions === 'function') {
                void setRenderOptions.call(existingPool, {
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
            }
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
                poolSize: config.poolSize,
                totalASTLRUCacheSize: config.totalASTLRUCacheSize,
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

        // Attach a catch handler to avoid unhandled rejections if workers fail to initialize.
        void created.initialize().catch(() => {});

        poolByStyle[style] = created;
        poolThemeKeyByStyle[style] = themeKey;
        pool = created;
        return created;
    } catch {
        poolByStyle[style] = null;
        poolThemeKeyByStyle[style] = undefined;
        pool = null;
        return poolByStyle[style];
    }
}
