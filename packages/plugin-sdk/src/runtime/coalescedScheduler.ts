/**
 * Generic single-flight coalescing scheduler: one in-flight `drain`, then at most one follow-up drain
 * for triggers that arrived while the first drain was running.
 */
export type CoalescedScheduler = Readonly<{
    trigger(): void;
    /** Trigger a drain; optionally join active work without queueing a follow-up. */
    flush(options?: Readonly<{ ifRunning: 'join' }>): Promise<void>;
    dispose(): void;
}>;

export function createCoalescedScheduler(params: Readonly<{
    drain: () => Promise<void>;
    onError?: (error: unknown) => void;
}>): CoalescedScheduler {
    let queued = false;
    let disposed = false;
    let activeRun: Promise<void> | null = null;

    function run(queueWhileActive = true): Promise<void> {
        if (disposed) return Promise.resolve();
        if (activeRun) {
            if (queueWhileActive) queued = true;
            return activeRun;
        }

        // Assign the completion barrier before invoking a drain that can synchronously trigger us.
        let resolveCycle!: () => void;
        let rejectCycle!: (error: unknown) => void;
        const completion = new Promise<void>((resolve, reject) => {
            resolveCycle = resolve;
            rejectCycle = reject;
        });
        activeRun = completion.finally(() => { activeRun = null; });
        const cycle = (async () => {
            try {
                do {
                    queued = false;
                    await params.drain();
                } while (queued && !disposed);
            } catch (error) {
                params.onError?.(error);
                throw error;
            }
        })();
        void cycle.then(resolveCycle, rejectCycle);
        return activeRun;
    }

    return Object.freeze({
        trigger() {
            // Diagnostics reach onError; an explicit flush receives the rejection.
            void run().catch(() => {});
        },
        flush(options?: Readonly<{ ifRunning: 'join' }>) {
            return run(options?.ifRunning !== 'join');
        },
        dispose() {
            disposed = true;
            queued = false;
        },
    });
}
