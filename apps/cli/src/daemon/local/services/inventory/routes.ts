import { LOCAL_SERVICE_INVENTORY_WATCH_WINDOW_MS } from '@happier-dev/protocol';

import type { LocalServiceInventoryLabelSource } from './labels';
import type {
    LocalServiceInventoryRegistry,
} from './registry';
import type { NormalizedLocalServiceInventorySnapshot } from './scanner';

export type LocalServiceInventoryWatchResult =
    | Readonly<{ changed: true; snapshot: NormalizedLocalServiceInventorySnapshot }>
    | Readonly<{ changed: false }>;

export type LocalServiceInventoryRoutes = Readonly<{
    getSnapshot(): Promise<NormalizedLocalServiceInventorySnapshot>;
    refreshSnapshot(): Promise<NormalizedLocalServiceInventorySnapshot>;
    /**
     * Park until the inventory changes (the push half of local-service freshness).
     *
     * This is the only production consumer of the registry's event producer. A caller keeps one
     * watch outstanding for as long as its surface is mounted and re-arms on each answer, so the
     * client never runs a refresh timer. `sinceGeneratedAt` closes the gap between the caller's
     * snapshot read and its first watch: a snapshot produced after the one the caller holds is
     * answered immediately instead of waiting for the next change.
     */
    watchSnapshot(input?: Readonly<{
        sinceGeneratedAt?: number;
        signal?: AbortSignal;
    }>): Promise<LocalServiceInventoryWatchResult>;
    /** Live count of parked watchers. The scan loop follows this rather than running unconditionally. */
    watcherCount(): number;
    patchLabel(input: Readonly<{
        inventoryId: string;
        label: Readonly<{ text: string }>;
        source: LocalServiceInventoryLabelSource;
        now: number;
    }>): Promise<Readonly<{ ok: true } | { ok: false; reason: 'unknown_inventory_entry' }>>;
}>;

export function createLocalServiceInventoryRoutes(input: Readonly<{
    registry: LocalServiceInventoryRegistry;
    refreshSnapshot?: () => Promise<NormalizedLocalServiceInventorySnapshot>;
    /**
     * Bring the snapshot up to date when a reader arrives without a parked watch. The scan loop
     * follows watchers, so a plain snapshot read is the one path that can otherwise observe an
     * inventory nobody has scanned. Coalesced by the same single flight as `refreshSnapshot`.
     */
    ensureFreshSnapshot?: () => Promise<void>;
    /** Daemon-owned park budget; callers derive their RPC timeout from the protocol constant. */
    watchWindowMs?: number;
    /** Fired whenever the parked-watcher count changes, so the runtime can follow demand. */
    onWatcherCountChanged?: (count: number) => void;
}>): LocalServiceInventoryRoutes {
    const watchWindowMs = input.watchWindowMs ?? LOCAL_SERVICE_INVENTORY_WATCH_WINDOW_MS;
    let watchers = 0;

    const setWatchers = (next: number): void => {
        watchers = next;
        input.onWatcherCountChanged?.(watchers);
    };

    return {
        async getSnapshot() {
            await input.ensureFreshSnapshot?.();
            return input.registry.getSnapshot();
        },
        async refreshSnapshot() {
            return input.refreshSnapshot ? await input.refreshSnapshot() : input.registry.getSnapshot();
        },
        async watchSnapshot(request = {}) {
            if (request.signal?.aborted) {
                return { changed: false };
            }
            const current = input.registry.getSnapshot();
            if (typeof request.sinceGeneratedAt === 'number' && current.generatedAt > request.sinceGeneratedAt) {
                return { changed: true, snapshot: current };
            }

            return await new Promise<LocalServiceInventoryWatchResult>((resolve) => {
                const teardown: Array<() => void> = [];
                let settled = false;
                const settle = (result: LocalServiceInventoryWatchResult): void => {
                    if (settled) return;
                    settled = true;
                    for (const run of teardown.splice(0)) run();
                    setWatchers(watchers - 1);
                    resolve(result);
                };

                setWatchers(watchers + 1);
                teardown.push(input.registry.subscribe(() => {
                    settle({ changed: true, snapshot: input.registry.getSnapshot() });
                }));

                const timer = setTimeout(() => settle({ changed: false }), watchWindowMs);
                timer.unref?.();
                teardown.push(() => clearTimeout(timer));

                const signal = request.signal;
                if (signal) {
                    const onAbort = (): void => settle({ changed: false });
                    signal.addEventListener('abort', onAbort, { once: true });
                    teardown.push(() => signal.removeEventListener('abort', onAbort));
                }
            });
        },
        watcherCount() {
            return watchers;
        },
        async patchLabel(patch) {
            return input.registry.applyLabelPatch({
                inventoryId: patch.inventoryId,
                text: patch.label.text,
                source: patch.source,
                updatedAt: patch.now,
            });
        },
    };
}
