import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/mini';
import { PileItemRefStoredV1Schema, StorageReasonV1Schema, type PileItemRefV1, type StorageItemRefV1, type StorageActorV1, type StorageSizeV1, type PileSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import { readProtectedLocalStateFile, writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';
import { physicalStoragePathWithoutFollowingLeaf as physicalPathWithoutFollowingLeaf, storageAbsolutePath as resolve,
    storagePathsEqual as canonicalAbsolutePathsEqual, storagePathContains, createStoragePathIndex } from './storagePath';
import { readStoragePathIdentity } from './trash/removeStoragePath';

export type PileStoredView = Readonly<{ items: PileItemRefV1[]; droppedSinceLastView: PileSummaryV1['droppedSinceLastView'] }>;
export type PileDelta = Readonly<{ add?: readonly StorageItemRefV1[]; remove?: readonly string[]; clear?: boolean; acknowledgeDropped?: readonly string[] }>;
export type DeclinedStorageItem = Readonly<{ ref: PileItemRefV1; size: StorageSizeV1; lastChangedAt?: number }>;
const storedState = z.object({ v: z.literal(1), items: z.array(PileItemRefStoredV1Schema),
    declined: z._default(z.record(z.string(), z.object({ path: z.string(), fingerprint: z.string() })), () => ({})),
    dropped: z._default(z.array(z.object({ itemId: z.string(), path: z.string(), reason: StorageReasonV1Schema })), () => []),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function identityMatches(ref: PileItemRefV1, identity: Awaited<ReturnType<typeof readStoragePathIdentity>>) {
    return ref.identity.dev === identity.dev && ref.identity.ino === identity.ino && ref.identity.kind === identity.kind;
}
export function pilePathContains(parent: string, child: string): boolean {
    return storagePathContains(parent, child);
}
/** One minimal physical union for selection, review and direct apply inputs. */
export function minimalPileUnion<T>(items: readonly T[], pathFor: (item: T) => string): T[] {
    const paths = items.map(item => ({ item, path: pathFor(item) }));
    const index = createStoragePathIndex(paths, value => value.path);
    return paths.filter(value => index.exact(value.path) === value
        && !index.ancestors(value.path).some(parent => parent !== value
            && !canonicalAbsolutePathsEqual(parent.path, value.path))).map(value => value.item);
}
export function createPileStore(deps: Readonly<{ activeServerDir: string; now?: () => number; onChanged?: () => void }>) {
    const now = deps.now ?? Date.now;
    const queues = new Map<string, Promise<unknown>>();
    const file = (accountId: string) => join(deps.activeServerDir, 'storage', 'piles', `${hash(accountId)}.json`);
    async function read(accountId: string): Promise<z.infer<typeof storedState>> {
        try { return storedState.parse(JSON.parse(await readProtectedLocalStateFile(file(accountId))) as unknown); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, items: [], declined: {}, dropped: [] }; throw error; }
    }
    const saveChanged = async (accountId: string, state: z.infer<typeof storedState>, changed: boolean, beforeEffect?: () => Promise<void>) => {
        if (!changed) return;
        await beforeEffect?.();
        await writeProtectedLocalStateFileAtomic(file(accountId), JSON.stringify(state), { authority: 'owned' });
        deps.onChanged?.();
    };
    function serial<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
        const operationResult = (queues.get(accountId) ?? Promise.resolve()).then(operation);
        queues.set(accountId, operationResult.catch(() => {})); return operationResult;
    }
    async function prune(state: z.infer<typeof storedState>) {
        const surviving: PileItemRefV1[] = [];
        for (const item of state.items) {
            try {
                const physical = await physicalPathWithoutFollowingLeaf(item.path);
                if (!canonicalAbsolutePathsEqual(physical, item.path) || !identityMatches(item, await readStoragePathIdentity(physical))) {
                    state.dropped.push({ itemId: item.itemId, path: item.path, reason: { code: 'changed_since_review' } });
                } else surviving.push(item);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                state.dropped.push({ itemId: item.itemId, path: item.path, reason: { code: 'missing' } });
            }
        }
        const changed = surviving.length !== state.items.length;
        state.items = surviving;
        return changed;
    }
    function view(state: z.infer<typeof storedState>): PileStoredView {
        return { items: [...state.items], droppedSinceLastView: [...state.dropped] };
    }
    const declinedFingerprint = (item: DeclinedStorageItem) => hash(JSON.stringify([
        item.ref.path, item.ref.identity.dev, item.ref.identity.ino ?? item.ref.identity.fileId, item.ref.identity.kind,
        item.size.allocatedBytes, item.lastChangedAt === undefined ? null : Math.floor(item.lastChangedAt / 86_400_000),
    ]));
    function readDeclined(accountId: string, items: readonly DeclinedStorageItem[], beforeEffect?: () => Promise<void>): Promise<ReadonlySet<string>> {
        if (items.length === 0) return Promise.resolve(new Set<string>());
        return serial(accountId, async () => {
            const state = await read(accountId);
            const matching = new Set<string>(); let changed = false;
            for (const item of items) {
                const declined = state.declined[item.ref.itemId];
                if (!declined) continue;
                let unchanged = false;
                try { unchanged = identityMatches(item.ref, await readStoragePathIdentity(item.ref.path)); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                if (unchanged && declined.fingerprint === declinedFingerprint(item)) matching.add(item.ref.itemId);
                else { delete state.declined[item.ref.itemId]; changed = true; }
            }
            await saveChanged(accountId, state, changed, beforeEffect);
            return matching;
        });
    }
    return {
        readDeclined,
        get(accountId: string, beforeEffect?: () => Promise<void>): Promise<PileStoredView> { return serial(accountId, async () => {
            const state = await read(accountId);
            const changed = await prune(state); const result = view(state);
            await saveChanged(accountId, state, changed, beforeEffect);
            return result;
        }); },
        set(accountId: string, delta: PileDelta, actor: StorageActorV1,
            resolveFingerprint?: (ref: StorageItemRefV1) => Promise<string | undefined>, beforeEffect?: () => Promise<void>): Promise<PileStoredView> {
            return serial(accountId, async () => {
                if (actor.accountId !== accountId) throw Object.assign(new Error('Pile actor mismatch'), { code: 'unauthorized' });
                const state = await read(accountId); const originalItems = state.items;
                let changed = await prune(state);
                if (delta.acknowledgeDropped?.length) {
                    const acknowledged = new Set(delta.acknowledgeDropped);
                    const retained = state.dropped.filter(item => !acknowledged.has(item.itemId));
                    changed ||= retained.length !== state.dropped.length;
                    state.dropped = retained;
                }
                const retained = delta.clear ? [] : state.items.filter(item => !delta.remove?.includes(item.itemId));
                let itemsChanged = retained.length !== state.items.length;
                state.items = retained;
                for (const supplied of delta.add ?? []) {
                    const path = await physicalPathWithoutFollowingLeaf(resolve(supplied.path));
                    const fingerprint = await resolveFingerprint?.(supplied);
                    const identity = await readStoragePathIdentity(path);
                    const item: PileItemRefV1 = { itemId: supplied.itemId, path, identity: { ...identity, ...(fingerprint ? { fingerprint } : {}) },
                        collectedAt: now(), collectedBy: actor };
                    const next = minimalPileUnion([...state.items, item], value => value.path);
                    if (!next.includes(item)) continue;
                    state.items = next;
                    itemsChanged = true;
                }
                // Only an edited selection needs a net-change comparison; unrelated
                // declined/dropped history never participates in item mutation detection.
                changed ||= itemsChanged && !isDeepStrictEqual(originalItems, state.items);
                const result = view(state); await saveChanged(accountId, state, changed, beforeEffect); return result;
            });
        },
        removeActed(accountId: string, itemIds: readonly string[], beforeEffect?: () => Promise<void>): Promise<void> { return serial(accountId, async () => {
            const state = await read(accountId); const previousLength = state.items.length;
            state.items = state.items.filter(item => !itemIds.includes(item.itemId));
            await saveChanged(accountId, state, state.items.length !== previousLength, beforeEffect);
        }); },
        decline(accountId: string, items: readonly DeclinedStorageItem[], beforeEffect?: () => Promise<void>): Promise<void> { return serial(accountId, async () => {
            const state = await read(accountId);
            const updates = new Map<string, { path: string; fingerprint: string }>();
            for (const item of items) {
                if (!identityMatches(item.ref, await readStoragePathIdentity(item.ref.path))) continue;
                updates.set(item.ref.itemId, { path: item.ref.path, fingerprint: declinedFingerprint(item) });
            }
            let changed = false;
            for (const [itemId, next] of updates) {
                const previous = state.declined[itemId];
                if (previous?.path === next.path && previous.fingerprint === next.fingerprint) continue;
                state.declined[itemId] = next;
                changed = true;
            }
            await saveChanged(accountId, state, changed, beforeEffect);
        }); },
        async isDeclined(accountId: string, item: DeclinedStorageItem, beforeEffect?: () => Promise<void>): Promise<boolean> {
            return (await readDeclined(accountId, [item], beforeEffect)).has(item.ref.itemId);
        },
    };
}
