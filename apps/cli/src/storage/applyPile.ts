import { randomUUID } from 'node:crypto';
import type { PileApplyResultV1, PileItemRefV1, StorageActorV1 } from '@happier-dev/protocol/storage/storageV1';
import type { StorageCategoryAdapter, StorageCleanupItem } from './categories/types';
import type { PileReviewDeps } from './reviewPile';
import type { createTrashStore } from './trash/trashStore';
import { PileFactError, pileFactsExpect, readPileFacts, storageSizeFromMeasurement } from './reviewPile';
import { readStoragePathIdentity } from './trash/removeStoragePath';
import { storagePathsEqual as canonicalAbsolutePathsEqual } from './storagePath';
import { minimalPileUnion } from './pileStore';

export type PileApplyInput = Readonly<{
    items: readonly Readonly<{ ref: PileItemRefV1; expect: string }>[];
    mode: 'trash' | 'delete'; actor: StorageActorV1; custodianAccountId: string; emptyAfter?: boolean;
    assertCurrent?(): Promise<void>;
    assertCurrentAuthority(item: StorageCleanupItem): Promise<void>;
}>;
export type PileApplyDeps = PileReviewDeps & Readonly<{
    trashStore: Pick<ReturnType<typeof createTrashStore>, 'prepare' | 'empty'>;
    resolveAdapter(item: StorageCleanupItem): Promise<StorageCategoryAdapter>;
    removeActed?(accountId: string, itemIds: readonly string[]): Promise<void>;
}>;
export async function applyPile(input: PileApplyInput, deps: PileApplyDeps): Promise<PileApplyResultV1> {
    const result: PileApplyResultV1 = { batchId: randomUUID(), mode: input.mode, outcomes: [], inTrashBytes: 0, freedBytes: 0 };
    const movedEntries: { entryId: string; itemId: string; payloadPath: string; bytes: number; item: StorageCleanupItem }[] = [];
    const emptiedEntries = new Set<string>();
    const acted: string[] = [];
    const completedChildren = new Set<string>();
    const reduced = minimalPileUnion(input.items, item => item.ref.path);
    async function execute(checked: PileApplyInput['items'][number], ancestorBeforeEffect?: () => Promise<void>): Promise<boolean> {
        try {
            await input.assertCurrent?.();
            const reviewedFacts = await readPileFacts(checked.ref, deps);
            if (reviewedFacts.classification.verdict === 'forbidden') throw new PileFactError('storage_forbidden', reviewedFacts.classification.reason);
            if (reviewedFacts.expect !== checked.expect) throw new PileFactError('changed_since_review');
            const recheck = async () => {
                await input.assertCurrent?.();
                const facts = await readPileFacts(checked.ref, deps);
                // Only our successful owned-child effects are an expected change.
                // A new/recreated child remains in current facts and fails comparison.
                if (facts.classification.verdict === 'forbidden') throw new PileFactError('storage_forbidden', facts.classification.reason);
                if (facts.children.some(child => completedChildren.has(child.ref.itemId))) throw new PileFactError('changed_since_review');
                if (pileFactsExpect(facts, completedChildren, reviewedFacts) !== pileFactsExpect(reviewedFacts, completedChildren))
                    throw new PileFactError('changed_since_review');
                return facts;
            };
            // SCM renames main/common authorities whole; contained facts are still in expect,
            // but their bytes and original back-references must remain inside that one payload.
            const separateChildren = reviewedFacts.item.retirementKind === 'main' || reviewedFacts.item.retirementKind === 'common'
                ? [] : reviewedFacts.children;
            for (const child of [...separateChildren].sort((left, right) => right.ref.path.length - left.ref.path.length)) {
                if (completedChildren.has(child.ref.itemId)) continue;
                await recheck();
                const childFacts = await readPileFacts(child.ref, deps);
                const completed = await execute({ ref: child.ref, expect: childFacts.expect }, async () => { await recheck(); });
                if (!completed) throw new PileFactError('facts_unavailable', { code: 'facts_unavailable', detail: { itemId: child.ref.itemId } });
            }
            // With no child effects there has been no wait since the admission
            // inspection. Owner binding/measurement may wait; beforeEffect below
            // still takes fresh facts at each destructive owner boundary.
            const facts = separateChildren.length ? await recheck() : reviewedFacts;
            const adapter = await deps.resolveAdapter(facts.item);
            const measured = await deps.measure({ paths: [facts.ref.path], measureSharedExtents: true });
            const measurement = measured.perPath.find(value => canonicalAbsolutePathsEqual(value.path, facts.ref.path));
            if (!measurement) throw new PileFactError('facts_unavailable');
            const size = storageSizeFromMeasurement(measurement);
            const beforeEffect = async () => {
                await ancestorBeforeEffect?.();
                const current = await recheck();
                await input.assertCurrentAuthority(current.item);
            };
            if (input.mode === 'trash') {
                const prepared = await deps.trashStore.prepare({ path: facts.ref.path, batchId: result.batchId, title: facts.item.title,
                    categoryId: facts.item.categoryId, identity: facts.identity, size, movedBy: input.actor, ownerData: adapter.ownerData,
                    restorable: adapter.restorable, assertCurrentAuthority: input.assertCurrent });
                const entry = await prepared.commit(async ({ payloadPath, beforeEffect: trashBeforeEffect }) => {
                    const composedBeforeEffect = async () => { await trashBeforeEffect?.(); await beforeEffect(); };
                    await input.assertCurrent?.();
                    await adapter.retire({ payloadPath, beforeEffect: composedBeforeEffect });
                });
                movedEntries.push({ entryId: entry.entryId, itemId: checked.ref.itemId, payloadPath: prepared.payloadPath,
                    bytes: entry.size.allocatedBytes, item: facts.item });
                result.inTrashBytes += entry.size.allocatedBytes;
                result.outcomes.push({ itemId: checked.ref.itemId, status: 'moved' });
            } else {
                await input.assertCurrent?.(); await adapter.discard({ beforeEffect });
                try { await readStoragePathIdentity(facts.ref.path); throw new Error('Storage owner left the removed path behind'); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                result.freedBytes += measured.totalExclusiveBytes;
                result.outcomes.push({ itemId: checked.ref.itemId, status: 'deleted' });
            }
            acted.push(checked.ref.itemId);
            completedChildren.add(checked.ref.itemId);
            return true;
        } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
            if (error instanceof PileFactError && code === 'storage_forbidden') {
                result.outcomes.push({ itemId: checked.ref.itemId, status: 'refused', reason: error.reason });
            } else if (code === 'changed_since_review' || code === 'missing' || code === 'ENOENT' || code === 'facts_unavailable' || code === 'unauthorized' || code === 'policy_unavailable') {
                result.outcomes.push({ itemId: checked.ref.itemId, status: 'skipped', reason: error instanceof PileFactError && error.reason
                    ? error.reason : { code: code === 'ENOENT' ? 'missing' : code } });
            } else result.outcomes.push({ itemId: checked.ref.itemId, status: 'failed', reason: { code: 'operation_failed' } });
            return false;
        }
    }
    for (const checked of reduced) await execute(checked);
    if (acted.length) {
        try { await deps.removeActed?.(input.actor.accountId, acted); }
        catch {
            // Effects already completed; a bookkeeping failure must not hide
            // them behind a top-level error or silently imply full success.
            for (const outcome of result.outcomes) if (acted.includes(outcome.itemId)
                && (outcome.status === 'moved' || outcome.status === 'deleted')) outcome.reason = { code: 'operation_failed' };
        }
    }
    if (input.mode === 'trash' && input.emptyAfter && movedEntries.length) {
        try {
            await input.assertCurrent?.();
            const empty = await deps.trashStore.empty({ entryIds: movedEntries.map(entry => entry.entryId) }, {
                actorAccountId: input.actor.accountId, custodianAccountId: input.custodianAccountId, assertCurrentAuthority: input.assertCurrent,
                assertEntryAuthority: async entry => {
                    const moved = movedEntries.find(moved => moved.entryId === entry.entryId);
                    if (!moved) throw new PileFactError('facts_unavailable');
                    // Keep the moved item's Session binding through the second
                    // effect; refreshed Machine admission alone does not prove it.
                    await input.assertCurrentAuthority(moved.item);
                },
            });
            result.freedBytes += empty.freedBytes;
            for (const outcome of empty.outcomes) {
                const moved = movedEntries.find(entry => entry.entryId === outcome.entryId)!;
                if (outcome.status === 'deleted') { emptiedEntries.add(moved.entryId); result.inTrashBytes -= moved.bytes; }
                else {
                    const item = result.outcomes.find(outcome => outcome.status === 'moved' && outcome.itemId === moved.itemId);
                    if (item) item.reason = outcome.reason ?? { code: 'operation_failed' };
                }
            }
        } catch (error) {
            const unauthorized = typeof error === 'object' && error !== null && 'code' in error && error.code === 'unauthorized';
            for (const outcome of result.outcomes) if (outcome.status === 'moved') outcome.reason = { code: unauthorized ? 'unauthorized' : 'operation_failed' };
        }
    }
    if (movedEntries.length) {
        const remaining = movedEntries.filter(entry => !emptiedEntries.has(entry.entryId));
        if (!remaining.length) result.inTrashBytes = 0;
        else {
            try {
                // Different entries can share one physical allocation. The
                // final union also accounts for growth during owner waits.
                const measured = await deps.measure({ paths: remaining.map(entry => entry.payloadPath), measureSharedExtents: true });
                result.inTrashBytes = measured.totalAllocatedBytes;
            } catch {
                // Preserve the committed receipts and make unavailable final
                // accounting visible rather than losing completed effects.
                for (const outcome of result.outcomes) if (outcome.status === 'moved' && !outcome.reason) outcome.reason = { code: 'operation_failed' };
            }
        }
    }
    if (input.mode === 'trash') result.trashEntryIds = movedEntries
        .filter(entry => !emptiedEntries.has(entry.entryId)).map(entry => entry.entryId);
    return result;
}
