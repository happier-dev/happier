/**
 * Generic single-flight coalescing scheduler: one in-flight `drain`, then at most one follow-up drain
 * for triggers that arrived while the first drain was running.
 */
export type CoalescedScheduler = Readonly<{
    trigger(): void;
    /** Trigger a drain and resolve only after the active single-flight cycle reaches idle. */
    flush(): Promise<void>;
    dispose(): void;
}>;

export function createCoalescedScheduler(params: Readonly<{
    drain: () => Promise<void>;
    onError?: (error: unknown) => void;
}>): CoalescedScheduler {
    let queued = false;
    let disposed = false;
    let activeRun: Promise<void> | null = null;

    function run(): Promise<void> {
        if (disposed) return Promise.resolve();
        if (activeRun) {
            queued = true;
            return activeRun;
        }

        const cycle = (async () => {
            try {
                do {
                    queued = false;
                    await params.drain();
                } while (queued && !disposed);
            } catch (error) {
                params.onError?.(error);
            }
        })();
        activeRun = cycle.finally(() => {
            activeRun = null;
        });
        return activeRun;
    }

    return Object.freeze({
        trigger() {
            void run();
        },
        flush() {
            return run();
        },
        dispose() {
            disposed = true;
            queued = false;
        },
    });
}
