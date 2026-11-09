import { areSnapshotProjectionsEquivalent, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import type { TeamCredentialResourceCatalogSnapshot } from './teamsSnapshots';

/** The existing Team catalog's admission and publication index, shared by every lifecycle writer. */
export class CredentialCatalogPublication {
    private readonly snapshots = new Map<string, TeamCredentialResourceCatalogSnapshot>();
    private readonly listeners = new Map<string, Set<() => void>>();
    private readonly changedKeys = new Set<string>();

    get(key: string): TeamCredentialResourceCatalogSnapshot | undefined { return this.snapshots.get(key); }
    values() { return this.snapshots.values(); }
    [Symbol.iterator]() { return this.snapshots[Symbol.iterator](); }

    set(key: string, incoming: TeamCredentialResourceCatalogSnapshot): boolean {
        const previous = this.snapshots.get(key);
        const data = incoming.data === previous?.data ? previous.data : incoming.data === null ? null
            : retainKeyedRows(previous?.data ?? null, incoming.data, row => row.id);
        const next = Object.freeze({ ...incoming, scope: previous?.scope ?? incoming.scope,
            address: previous?.address ?? incoming.address, data });
        // Observation time remains readable by the refresh owner, but is not a changed catalog fact.
        const changed = !previous || previous.data !== data || previous.status !== next.status
            || previous.stale !== next.stale || previous.selectionCurrent !== next.selectionCurrent
            || previous.reachability !== next.reachability || !areSnapshotProjectionsEquivalent(previous.error, next.error);
        this.snapshots.set(key, next);
        if (changed) this.changedKeys.add(key);
        return changed;
    }

    delete(key: string): boolean {
        if (!this.snapshots.delete(key)) return false;
        this.changedKeys.add(key);
        return true;
    }

    subscribe(keys: readonly string[], listener: () => void): () => void {
        const selected = new Set(keys);
        for (const key of selected) {
            let listeners = this.listeners.get(key);
            if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
            listeners.add(listener);
        }
        return () => {
            for (const key of selected) {
                const listeners = this.listeners.get(key);
                listeners?.delete(listener);
                if (listeners?.size === 0) this.listeners.delete(key);
            }
        };
    }

    /** The parent commits one notification wave after all affected keys have been applied. */
    flush(): void {
        const affected = new Set<() => void>();
        for (const key of this.changedKeys) for (const listener of this.listeners.get(key) ?? []) affected.add(listener);
        this.changedKeys.clear();
        for (const listener of affected) {
            try { listener(); } catch { /* A subscriber cannot suppress another selected consumer. */ }
        }
    }

    clear(): void { this.snapshots.clear(); this.listeners.clear(); this.changedKeys.clear(); }
}
