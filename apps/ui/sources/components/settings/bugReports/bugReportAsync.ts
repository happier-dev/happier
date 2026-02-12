export function resolvePositiveInt(raw: unknown, fallback: number, min: number, max: number): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(raw)));
}

export async function runWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T | null> {
    const normalizedTimeout = Math.max(1, Math.floor(timeoutMs));
    return await new Promise<T | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(null);
        }, normalizedTimeout);

        void operation()
            .then((value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            })
            .catch(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(null);
            });
    });
}

export async function runAbortableWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
): Promise<T | null> {
    const controller = new AbortController();
    const normalizedTimeout = Math.max(1, Math.floor(timeoutMs));
    return await new Promise<T | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            controller.abort();
            if (settled) return;
            settled = true;
            resolve(null);
        }, normalizedTimeout);

        void operation(controller.signal)
            .then((value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            })
            .catch(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(null);
            });
    });
}
