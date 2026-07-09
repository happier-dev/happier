/**
 * Generic single-flight coalescing scheduler: one in-flight `drain`, then at most one follow-up drain
 * for triggers that arrived while the first drain was running.
 */
export type CoalescedScheduler = Readonly<{
    trigger(): void;
    dispose(): void;
}>;

export function createCoalescedScheduler(params: Readonly<{
    drain: () => Promise<void>;
    onError?: (error: unknown) => void;
}>): CoalescedScheduler {
    let active = false;
    let queued = false;
    let disposed = false;

    async function run(): Promise<void> {
        if (active || disposed) {
            queued = true;
            return;
        }
        active = true;
        try {
            do {
                queued = false;
                await params.drain();
            } while (queued && !disposed);
        } catch (error) {
            params.onError?.(error);
        } finally {
            active = false;
        }
    }

    return Object.freeze({
        trigger() {
            void run();
        },
        dispose() {
            disposed = true;
            queued = false;
        },
    });
}
