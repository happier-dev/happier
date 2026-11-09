export type RaceWithTimeoutResult<T> =
    | Readonly<{ type: 'resolved'; value: T }>
    | Readonly<{ type: 'rejected'; error: unknown }>
    | Readonly<{ type: 'timeout' }>;

export async function raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<RaceWithTimeoutResult<T>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise
                .then((value) => ({ type: 'resolved' as const, value }))
                .catch((error: unknown) => ({ type: 'rejected' as const, error })),
            new Promise<Readonly<{ type: 'timeout' }>>((resolve) => {
                timer = setTimeout(() => resolve({ type: 'timeout' }), Math.max(0, Math.trunc(timeoutMs)));
                const timerHandle: unknown = timer;
                if (typeof timerHandle === 'object' && timerHandle !== null
                    && 'unref' in timerHandle && typeof timerHandle.unref === 'function') {
                    timerHandle.unref();
                }
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
