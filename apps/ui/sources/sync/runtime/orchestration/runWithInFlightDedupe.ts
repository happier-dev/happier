export function runWithInFlightDedupe<T>(
    state: {
        get: () => Promise<T> | null;
        set: (value: Promise<T> | null) => void;
    },
    task: () => Promise<T>
): Promise<T> {
    const existing = state.get();
    if (existing) {
        return existing;
    }

    const run = (async () => {
        try {
            return await task();
        } finally {
            state.set(null);
        }
    })();

    state.set(run);
    return run;
}
