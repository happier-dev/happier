import { projectLocalServiceMachineSummaryV1, type LocalServiceMachineSummaryV1 } from '@happier-dev/protocol/local/services/inventory/v1';

import { createParkWatch, type ParkWatchResult } from '@/daemon/lifecycle/parkWatch';

import type { LocalServiceInventoryLabelSource } from './labels';
import type {
    LocalServiceInventoryRegistry,
} from './registry';
import type { NormalizedLocalServiceInventorySnapshot } from './scanner';

export type LocalServiceInventoryWatchResult = ParkWatchResult<NormalizedLocalServiceInventorySnapshot>;

export type LocalServiceInventoryRoutes = Readonly<{
    getSummary?(): LocalServiceMachineSummaryV1;
    /** Latest observation, including silent timestamp updates, without awaiting a new scan. */
    readCurrentSnapshot(): NormalizedLocalServiceInventorySnapshot;
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
        /** Retain producer demand until cancellation, across material value replies. */
        observationOnly?: boolean;
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
    getSummary?: () => LocalServiceMachineSummaryV1;
    refreshSnapshot?: () => Promise<NormalizedLocalServiceInventorySnapshot>;
    /**
     * Bring the snapshot up to date when a reader arrives without a parked watch. The scan loop
     * follows watchers, so a plain snapshot read is the one path that can otherwise observe an
     * inventory nobody has scanned. Coalesced by the same single flight as `refreshSnapshot`.
     */
    ensureFreshSnapshot?: () => Promise<void>;
    /** Fired whenever the parked-watcher count changes, so the runtime can follow demand. */
    onWatcherCountChanged?: (count: number) => void;
}>): LocalServiceInventoryRoutes {
    const watches = createParkWatch({ onWatcherCountChanged: input.onWatcherCountChanged });

    return {
        getSummary: input.getSummary ?? (() => projectLocalServiceMachineSummaryV1(input.registry.getSnapshot())),
        readCurrentSnapshot: input.registry.getSnapshot,
        async getSnapshot() {
            await input.ensureFreshSnapshot?.();
            return input.registry.getSnapshot();
        },
        async refreshSnapshot() {
            return input.refreshSnapshot ? await input.refreshSnapshot() : input.registry.getSnapshot();
        },
        async watchSnapshot(request = {}) {
            if (request.signal?.aborted) return { changed: false };
            if (request.observationOnly) {
                // The same parking owner counts this mounted lifetime. Material
                // events wake value readers, never release the consumer's demand.
                return await watches.parkWatch({
                    isNewer: () => false,
                    subscribe: () => () => {},
                    read: input.registry.getSnapshot,
                    signal: request.signal,
                });
            }
            if (input.ensureFreshSnapshot) await input.ensureFreshSnapshot();
            return await watches.parkWatch({
                isNewer: () => typeof request.sinceGeneratedAt === 'number'
                    && input.registry.getSnapshot().generatedAt > request.sinceGeneratedAt,
                subscribe: input.registry.subscribe,
                read: input.registry.getSnapshot,
                signal: request.signal,
            });
        },
        watcherCount() {
            return watches.watcherCount();
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
