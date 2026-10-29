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
    // Preserve an explicit UI-only allocation without imposing another ceiling.
    const legacy = options.legacyUiOverride
        ? positiveInteger(env.VITEST_UI_MAX_FORKS)
        : undefined;
    // The execution governor may reduce the package default. Keep this budget
    // separate from Vitest's pool env/argv, which override package policy.
    const governor = positiveInteger(env.HAPPIER_VITEST_GOVERNOR_MAX_WORKERS);
    const defaultWorkers = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
    return {
        minWorkers: 1,
        maxWorkers: override
            ?? legacy
            ?? Math.min(defaultWorkers, governor ?? defaultWorkers),
    };
}

/** Vitest 3 pool-specific environment values take precedence over maxWorkers. */
export function resolveVitestPoolEnv(workers: ReturnType<typeof resolveVitestWorkers>) {
    return {
        VITEST_MAX_FORKS: String(workers.maxWorkers),
        VITEST_MIN_FORKS: String(workers.minWorkers),
        VITEST_MAX_THREADS: String(workers.maxWorkers),
        VITEST_MIN_THREADS: String(workers.minWorkers),
    };
}
