import type { SupportedLanguages } from '@pierre/diffs';
import { WorkerPoolManager } from '@pierre/diffs/worker';

import { ensureHappierPierreThemesRegistered, HAPPIER_PIERRE_THEME_IDS } from './pierreThemeRegistry.web';
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

export function getPierreDiffWorkerPool(params?: Readonly<{ style?: PierreDiffPresentationStyle }>): WorkerPoolManager | null {
    if (typeof window === 'undefined') return null;
    if (typeof requestAnimationFrame !== 'function') return null;
    const style: PierreDiffPresentationStyle = params?.style ?? 'split';
    if (poolByStyle[style] !== undefined) return poolByStyle[style] ?? null;

    ensureHappierPierreThemesRegistered();

    try {
        // Fail-closed: ensure we can construct a module worker before booting the pool.
        // WorkerPoolManager initializes asynchronously; without this preflight, failures can surface
        // as unhandled rejections in some environments.
        const probe = createPierreDiffWorker();
        probe.terminate();

        const config = resolvePierreWorkerPoolConfig(style);

        const created = new WorkerPoolManager(
            {
                workerFactory: createPierreDiffWorker,
                poolSize: config.poolSize,
                totalASTLRUCacheSize: config.totalASTLRUCacheSize,
            },
            {
                theme: {
                    light: HAPPIER_PIERRE_THEME_IDS.light,
                    dark: HAPPIER_PIERRE_THEME_IDS.dark,
                },
                langs: PRELOAD_LANGS,
                lineDiffType: config.defaultLineDiffType,
                preferredHighlighter: 'shiki-wasm',
            },
        );

        // Attach a catch handler to avoid unhandled rejections if workers fail to initialize.
        void created.initialize().catch(() => {});

        poolByStyle[style] = created;
        pool = created;
        return created;
    } catch {
        poolByStyle[style] = null;
        pool = null;
        return poolByStyle[style];
    }
}
