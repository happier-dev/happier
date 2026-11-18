import { projectLocalServiceMachineSummaryV1, type LocalServiceMachineSummaryV1 } from '@happier-dev/protocol/local/services/inventory/v1';
import type { LocalServiceLauncherScopeV1, LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { isDeepStrictEqual } from 'node:util';

import { createParkWatch, type ParkWatchResult } from '@/daemon/lifecycle/parkWatch';
import { getHostWorktreePortsOwner, type WorktreePortsOwner } from '@/workspaces/execution/worktreePorts';

import type { LocalServiceInventoryLabelSource } from './labels';
import type {
    LocalServiceInventoryRegistry,
} from './registry';
import type { NormalizedLocalServiceInventorySnapshot } from './scanner';

export type LocalServiceInventoryWatchResult = ParkWatchResult<NormalizedLocalServiceInventorySnapshot> & Readonly<{
    /** The snapshot the caller holds (`sinceGeneratedAt`), when this owner still has it. */
    base?: NormalizedLocalServiceInventorySnapshot;
}>;

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
        launcherScopes?: readonly LocalServiceLauncherScopeV1[];
        signal?: AbortSignal;
    }>): Promise<LocalServiceInventoryWatchResult>;
    /** The same parked owner, restricted to the caller's already-admitted launcher projection. */
    watchLauncherSnapshot(input: Readonly<{
        targets: LocalServiceLauncherSnapshotV1['targets'];
        worktreePorts?: LocalServiceLauncherSnapshotV1['worktreePorts'];
        readSnapshot(): Promise<LocalServiceLauncherSnapshotV1>;
        launcherScopes?: readonly LocalServiceLauncherScopeV1[];
        signal?: AbortSignal;
    }>): Promise<ParkWatchResult<LocalServiceLauncherSnapshotV1>>;
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
    worktreePorts?: Pick<WorktreePortsOwner, 'subscribe'>;
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
    observeLauncherScopes?: (scopes: readonly LocalServiceLauncherScopeV1[], signal?: AbortSignal) => Promise<() => void>;
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
            const release = request.launcherScopes?.length
                ? await input.observeLauncherScopes?.(request.launcherScopes, request.signal) : undefined;
            try {
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
                const held = input.registry.getSnapshot();
                const base = held.generatedAt === request.sinceGeneratedAt ? held : undefined;
                if (input.ensureFreshSnapshot) await input.ensureFreshSnapshot();
                const result = await watches.parkWatch({
                    isNewer: () => typeof request.sinceGeneratedAt === 'number'
                        && input.registry.getSnapshot().generatedAt > request.sinceGeneratedAt,
                    subscribe: input.registry.subscribe,
                    read: input.registry.getSnapshot,
                    signal: request.signal,
                });
                return result.changed && base ? { ...result, base } : result;
            } finally { release?.(); }
        },
        async watchLauncherSnapshot(request) {
            const release = request.launcherScopes?.length
                ? await input.observeLauncherScopes?.(request.launcherScopes, request.signal) : undefined;
            let releasePorts: (() => void) | undefined;
            let wakePorts: (() => void) | undefined;
            const unchanged = (snapshot: LocalServiceLauncherSnapshotV1) => isDeepStrictEqual(snapshot.targets, request.targets)
                && isDeepStrictEqual(snapshot.worktreePorts, request.worktreePorts);
            try {
                while (!request.signal?.aborted) {
                    const snapshot = await request.readSnapshot();
                    if (!unchanged(snapshot)) return { changed: true, snapshot };
                    // The admitted projection supplies the root, never the caller's echoed baseline.
                    // No opted-in selected root means no assignment-owner subscription or work.
                    if (!releasePorts && snapshot.worktreePorts) releasePorts = await (input.worktreePorts ?? getHostWorktreePortsOwner())
                        .subscribe({ rootPath: snapshot.worktreePorts.rootPath }, () => wakePorts?.());
                    let readFailure: unknown;
                    const result = await watches.parkWatch({
                        isNewer: () => false,
                        subscribe(listener) {
                            const unsubscribe = input.registry.subscribe(listener);
                            wakePorts = listener;
                            // Close the async projection-read/subscribe gap at the existing watch owner.
                            void request.readSnapshot().then(current => {
                                if (!unchanged(current)) listener();
                            }, error => { readFailure = error; listener(); });
                            return () => { wakePorts = undefined; unsubscribe(); };
                        },
                        read: () => undefined,
                        signal: request.signal,
                    });
                    if (readFailure !== undefined) throw readFailure;
                    if (!result.changed) return { changed: false };
                    // Unrelated Machine activity stays inside the owner. Only a material
                    // change to this requester's projection can settle the remote watch.
                }
                return { changed: false };
            } finally { releasePorts?.(); release?.(); }
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
