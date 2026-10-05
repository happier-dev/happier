import { availableParallelism } from 'node:os';

function positiveInteger(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** One invocation must leave room for other work on a shared development host.
 * CI uses the same default; an explicitly sized job may override it.
 */
export function resolveVitestWorkers(options: {
    env?: NodeJS.ProcessEnv;
    legacyUiOverride?: boolean;
} = {}): { minWorkers: number; maxWorkers: number } {
    const env = options.env ?? process.env;
    const override = positiveInteger(env.HAPPIER_VITEST_MAX_WORKERS);
    // Preserve the existing UI-only override and its six-worker ceiling.
    const legacy = options.legacyUiOverride
        ? positiveInteger(env.VITEST_UI_MAX_FORKS)
        : undefined;
    return {
        minWorkers: 1,
        maxWorkers: override
            ?? (legacy === undefined ? undefined : Math.min(legacy, 6))
            ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    };
}
