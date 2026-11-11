import type { PlannedKvAction } from '@/sync/runtime/orchestration/changesPlanner';
import type { PluginAccountDataObservationV1 } from '@happier-dev/protocol/plugins/data/hostedWebAccountDataBridgeV1';
import { readTaskResourceChangeEntityIdV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import { classifyAccountJsonKvKey } from '@happier-dev/protocol/account/accountJsonKv';
import { ChangeEntrySchema, PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes';
import type { PluginCollectionInvalidation } from '@happier-dev/plugin-sdk/collections';

import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

export type PluginCollectionChangeWatchV1 = Readonly<{ dispose(): void }>;

export type WatchActivePluginCollectionChangesInput = Readonly<{
    pluginId: string;
    collectionId: string;
    rowId?: string;
    onInvalidated(invalidation?: PluginCollectionInvalidation): void;
    accountLifetime?: ActiveServerAccountScopeLifetime;
}>;

type ActivePluginCollectionChangeWatch = Readonly<{
    pluginId: string;
    collectionId?: string;
    kvKey?: string;
    internalTasks?: boolean;
    rowId?: string;
    lifetime: ActiveServerAccountScopeLifetime;
    onInvalidated: (invalidation?: PluginCollectionInvalidation) => void;
    readBasis?: Readonly<{ owner: object; key: string }>;
    contractDigest?: string;
    indexSelection?: Readonly<{ indexId: string; prefixes: readonly string[] }>;
}> & { lastObservedCursor: number | null; acquiringReads: number; pendingChangeCursor: number | null };

const activeWatches = new Set<ActivePluginCollectionChangeWatch>();

export function registerActivePluginCollectionChangeWatch(input: Readonly<{
    pluginId: string;
    collectionId?: string;
    kvKey?: string;
    internalTasks?: boolean;
    rowId?: string;
    lifetime: ActiveServerAccountScopeLifetime;
    onInvalidated(invalidation?: PluginCollectionInvalidation): void;
    readBasis?: Readonly<{ owner: object; key: string }>;
    acquisitionCursor?: number;
    contractDigest?: string;
    indexSelection?: Readonly<{ indexId: string; prefixes: readonly string[] }>;
}>): PluginCollectionChangeWatchV1 {
    const watch: ActivePluginCollectionChangeWatch = {
        ...input, lastObservedCursor: input.acquisitionCursor ?? null, acquiringReads: 0, pendingChangeCursor: null,
    };
    let disposed = false;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        activeWatches.delete(watch);
        retirement?.dispose();
        retirement = null;
    };
    activeWatches.add(watch);
    retirement = input.lifetime.onRetire(dispose);
    if (!input.lifetime.isCurrent()) dispose();
    return Object.freeze({ dispose });
}

/** A successful first-page snapshot covers only its incumbent, bound selectors. */
export function captureActivePluginCollectionReadBasis(input: Readonly<{
    pluginId: string;
    collectionId: string;
    lifetime: ActiveServerAccountScopeLifetime;
    readBasis: Readonly<{ owner: object; key: string }>;
}>): (changeCursor?: number) => void {
    const watches = [...activeWatches].filter(watch => watch.pluginId === input.pluginId
        && watch.collectionId === input.collectionId && watch.lifetime === input.lifetime
        && watch.readBasis?.owner === input.readBasis.owner && watch.readBasis.key === input.readBasis.key);
    const acquiring = new Set(watches.filter(watch => watch.lastObservedCursor === null));
    for (const watch of acquiring) watch.acquiringReads++;
    let settled = false;
    return changeCursor => {
        if (settled) return;
        settled = true;
        for (const watch of watches) {
            if (!activeWatches.has(watch) || !watch.lifetime.isCurrent()) continue;
            if (changeCursor !== undefined) watch.lastObservedCursor = Math.max(watch.lastObservedCursor ?? 0, changeCursor);
            if (acquiring.has(watch)) watch.acquiringReads--;
            if ((watch.acquiringReads !== 0 && watch.lastObservedCursor === null) || watch.pendingChangeCursor === null) continue;
            const pendingCursor = watch.pendingChangeCursor;
            watch.pendingChangeCursor = null;
            if (watch.lastObservedCursor !== null && pendingCursor <= watch.lastObservedCursor) continue;
            watch.lastObservedCursor = pendingCursor;
            notifyWatches([watch], Object.freeze({ kind: 'changed', changeCursor: pendingCursor }));
        }
    };
}

function notifyWatches(watches: Iterable<ActivePluginCollectionChangeWatch>, invalidation?: PluginCollectionInvalidation): void {
    for (const watch of watches) {
        if (!activeWatches.has(watch) || !watch.lifetime.isCurrent()) continue;
        try {
            watch.onInvalidated(invalidation);
        } catch {
            // Presentation callbacks cannot affect canonical Account changes.
        }
    }
}

export function watchActivePluginCollectionChanges(
    input: WatchActivePluginCollectionChangesInput,
): PluginCollectionChangeWatchV1 | null {
    const lifetime = input.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime || !lifetime.isCurrent()) return null;
    return registerActivePluginCollectionChangeWatch({ ...input, lifetime });
}

export function registerActivePluginAccountDataChangeWatch(input: Readonly<{
    pluginId: string;
    selection: PluginAccountDataObservationV1;
    lifetime: ActiveServerAccountScopeLifetime;
    onInvalidated(): void;
}>): PluginCollectionChangeWatchV1 {
    const selection = input.selection;
    return registerActivePluginCollectionChangeWatch({ ...input,
        ...(selection.kind === 'kv' ? { kvKey: selection.key }
            : selection.kind === 'collection' ? { collectionId: selection.collectionId } : { internalTasks: true }),
    });
}

export function publishActivePluginCollectionChanges(changes: readonly unknown[], kv?: PlannedKvAction): void {
    // Sync already normalized the content-free KV hint. Consume that fact
    // rather than parsing a second copy of the hinted-key/full contract.
    const taskKeysChanged = kv?.type === 'refresh-feature'
        || kv?.type === 'bulk-keys' && kv.keys.some(key => classifyAccountJsonKvKey(key) === 'todo');
    const affected = new Map<ActivePluginCollectionChangeWatch, number>();
    for (const rawChange of changes) {
        const accountChange = ChangeEntrySchema.safeParse(rawChange);
        if (accountChange.success && accountChange.data.kind === 'kv') {
            const { entityId, cursor } = accountChange.data;
            if (taskKeysChanged || readTaskResourceChangeEntityIdV1(entityId) || classifyAccountJsonKvKey(entityId) === 'todo') {
                for (const watch of activeWatches) {
                    if (!watch.internalTasks || (watch.lastObservedCursor !== null && cursor <= watch.lastObservedCursor)) continue;
                    affected.set(watch, Math.max(affected.get(watch) ?? cursor, cursor));
                    watch.lastObservedCursor = cursor;
                }
            }
            continue;
        }
        const parsed = PluginDomainChangeEntrySchema.safeParse(rawChange);
        if (!parsed.success) continue;
        if (parsed.data.hint.pluginDomain === 'dataKv') {
            const { hint, cursor } = parsed.data;
            for (const watch of activeWatches) {
                if (watch.kvKey === undefined || watch.pluginId !== hint.pluginId
                    || (watch.lastObservedCursor !== null && cursor <= watch.lastObservedCursor)) continue;
                if ('full' in hint || hint.keys.includes(watch.kvKey)) affected.set(watch, cursor);
                watch.lastObservedCursor = cursor;
            }
            continue;
        }
        if (parsed.data.hint.pluginDomain !== 'dataCollection') continue;
        const { hint } = parsed.data;
        const { pluginId, collectionId } = hint;
        for (const watch of activeWatches) {
            if (watch.pluginId !== pluginId || watch.collectionId !== collectionId) continue;
            const observed = watch.lastObservedCursor;
            const awaitingBasis = watch.acquiringReads > 0 && observed === null;
            // The query snapshot or a prior publication already covers this
            // cursor. Catch-up is not itself a change to the observed data.
            if (observed !== null && parsed.data.cursor <= observed) continue;
            const missedPredecessor = 'indexChanges' in hint && hint.indexChanges
                && (observed === null || observed < hint.indexChanges.previousCursor);
            const differentContract = watch.contractDigest !== undefined && watch.contractDigest !== hint.contractDigest;
            const indexChanges = 'indexChanges' in hint ? hint.indexChanges : undefined;
            const selection = watch.indexSelection;
            const matchesIndex = !selection || !indexChanges || indexChanges.keys.some(key => key.indexId === selection.indexId
                && selection.prefixes.some(prefix => key.key.startsWith(prefix)));
            if ('full' in hint || missedPredecessor || differentContract
                || (watch.rowId === undefined ? matchesIndex : hint.rowIds.includes(watch.rowId))) {
                if (awaitingBasis) {
                    // Let the pending initial snapshot establish whether this
                    // feed row precedes acquisition. A later fact is delivered
                    // once when that read settles, including read failure.
                    watch.pendingChangeCursor = Math.max(watch.pendingChangeCursor ?? 0, parsed.data.cursor);
                } else {
                    affected.set(watch, Math.max(affected.get(watch) ?? parsed.data.cursor, parsed.data.cursor));
                }
            }
            if (!awaitingBasis) watch.lastObservedCursor = Math.max(observed ?? 0, parsed.data.cursor);
        }
    }
    for (const [watch, changeCursor] of affected) {
        notifyWatches([watch], Object.freeze({ kind: 'changed', changeCursor }));
    }
}

export function resetActivePluginCollectionChanges(): void {
    captureActivePluginCollectionChangeReset()();
}

/** Snapshot repair covers observations that precede its base, not later fresh reads. */
export function captureActivePluginCollectionChangeReset(): () => void {
    const watches = [...activeWatches];
    return () => {
        for (const watch of watches) {
            if (activeWatches.has(watch)) watch.lastObservedCursor = null;
        }
        notifyWatches(watches);
    };
}
