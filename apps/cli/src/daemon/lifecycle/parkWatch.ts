import { waitForChangeOrDeadline } from './waitForChangeOrDeadline';

export type ParkWatchResult<T> = Readonly<{ changed: true; snapshot: T }> | Readonly<{ changed: false }>;
export type ParkWatchInput<T> = Readonly<{
    isNewer(): boolean;
    subscribe(listener: () => void): () => void;
    read(): T;
    signal?: AbortSignal;
}>;
export type ParkWatchOwner = Readonly<{
    parkWatch<T>(input: ParkWatchInput<T>): Promise<ParkWatchResult<T>>;
    watcherCount(): number;
}>;

/** One counter per machine-watch owner; demand starts only after the subscription is installed. */
export function createParkWatch(options: Readonly<{
    onWatcherCountChanged?: (count: number) => void;
}> = {}): ParkWatchOwner {
    let watchers = 0;
    return {
        async parkWatch<T>(input: ParkWatchInput<T>): Promise<ParkWatchResult<T>> {
            if (input.signal?.aborted) return { changed: false };
            if (input.isNewer()) return { changed: true, snapshot: input.read() };
            let parked = false;
            let unsubscribe: (() => void) | undefined;
            let removeAbort: (() => void) | undefined;
            try {
                const result = await waitForChangeOrDeadline({
                    signal: input.signal,
                    waitForChange(signal) {
                        return new Promise<void>(resolve => {
                            unsubscribe = input.subscribe(resolve);
                            const onAbort = () => resolve();
                            signal.addEventListener('abort', onAbort, { once: true });
                            removeAbort = () => signal.removeEventListener('abort', onAbort);
                            parked = true;
                            watchers += 1;
                            options.onWatcherCountChanged?.(watchers);
                            // Close both the read-subscribe gap and cancellation during subscription/demand.
                            if (signal.aborted || input.isNewer()) resolve();
                        });
                    },
                });
                return result === 'changed' ? { changed: true, snapshot: input.read() } : { changed: false };
            } finally {
                unsubscribe?.();
                removeAbort?.();
                if (parked) {
                    watchers -= 1;
                    options.onWatcherCountChanged?.(watchers);
                }
            }
        },
        watcherCount(): number {
            return watchers;
        },
    };
}

const sharedWatches = createParkWatch();
export const parkWatch = sharedWatches.parkWatch;
export const watcherCount = sharedWatches.watcherCount;
