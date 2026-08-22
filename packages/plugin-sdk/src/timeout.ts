export type RaceWithTimeoutResult<T> =
    | Readonly<{ type: 'resolved'; value: T }>
    | Readonly<{ type: 'rejected'; error: unknown }>
    | Readonly<{ type: 'timeout' }>;

export async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(0, Math.trunc(ms)));
    });
}

export function throwIfAborted(signal?: AbortSignal | null): void {
    if (!signal?.aborted) return;
    if (signal.reason !== undefined) throw signal.reason;
    throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

export async function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) {
        throw abortReason(signal);
    }
    await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(signal ? abortReason(signal) : new Error('Aborted'));
        };
        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, Math.max(0, Math.trunc(ms)));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

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
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function abortReason(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) {
        return signal.reason;
    }
    return new Error(typeof signal.reason === 'string' && signal.reason.trim() ? signal.reason : 'Aborted');
}
