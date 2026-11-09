import { appendFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import type { PileItemRefV1, StorageActorV1, StorageSizeV1 } from '@happier-dev/protocol/storage/storageV1';
import { PileApplyResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import type { StorageCategoryAdapter, StorageCategoryItem, StorageCleanupItem } from './categories/types';
import { createPileStore, minimalPileUnion } from './pileStore';
import { reviewPile, type PileReviewDeps } from './reviewPile';
import { applyPile } from './applyPile';
import { measureNativeDisk } from './measure/nativeDiskMeasure';
import { createTrashStore } from './trash/trashStore';
import { readStoragePathIdentity } from './trash/removeStoragePath';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { bindFilesystemItem, filesystemAdapterForEntry } from './categories/filesystemAdapters';

let disposeNative: (() => Promise<void>) | undefined;
const actor: StorageActorV1 = { accountId: 'owner', kind: 'agent' };
const zero: StorageSizeV1 = { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false };
let scratch: string;
async function ref(path: string): Promise<PileItemRefV1> {
    return { itemId: path, path, identity: await readStoragePathIdentity(path), collectedAt: 1, collectedBy: actor };
}
describe.skipIf(process.platform === 'win32' && process.arch !== 'x64')('canonical pile filesystem flow', () => {
    beforeAll(async () => {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-pile-test-')));
        disposeNative = await createProcessCustodyFixture();
    });
    afterAll(async () => { await disposeNative?.(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

    it('reads each selected path once when reducing a thousand retained siblings and nested duplicates', () => {
        const siblings = Array.from({ length: 1_000 }, (_, index) => ({ path: join(scratch, 'union-cost', `sibling-${index}`) }));
        const parent = { path: join(scratch, 'union-cost', 'selected') };
        const items = [...siblings, { path: join(parent.path, 'child') }, parent, { ...parent }];
        let pathReads = 0;
        const reduced = minimalPileUnion(items, item => { pathReads++; return item.path; });
        expect(reduced).toEqual([...siblings, parent]);
        expect(pathReads).toBe(items.length);
    });

    it('persists a minimal physical union with trusted identity/actor, drops swaps and isolates Accounts', async () => {
        const folder = join(scratch, 'union'); await mkdir(folder); const child = join(folder, 'child'); await writeFile(child, 'data');
        const store = createPileStore({ activeServerDir: join(scratch, 'state'), now: () => 100 });
        const supplied = { ...await ref(child), identity: { dev: 'fake', ino: 'fake', kind: 'directory' as const },
            collectedBy: { accountId: 'fake', kind: 'person' as const } };
        const collected = await store.set('owner', { add: [supplied] }, actor);
        expect(collected.items[0]).toMatchObject({ identity: await readStoragePathIdentity(child), collectedBy: actor, collectedAt: 100 });
        expect((await store.set('owner', { add: [await ref(folder)] }, actor)).items.map(item => item.path)).toEqual([folder]);
        expect((await store.set('owner', { add: [await ref(child)] }, actor)).items.map(item => item.path)).toEqual([folder]);
        expect((await createPileStore({ activeServerDir: join(scratch, 'state') }).get('owner')).items).toHaveLength(1);
        expect((await store.get('other')).items).toEqual([]);
        expect(await readdir(join(scratch, 'state', 'storage', 'piles'))).toHaveLength(1);
        await rename(folder, `${folder}-old`); await mkdir(folder);
        expect(await store.get('owner')).toMatchObject({ items: [], droppedSinceLastView: [{ itemId: folder, reason: { code: 'changed_since_review' } }] });
    });

    it('retains dropped facts across readers and restarts until an explicit Account-scoped acknowledgement', async () => {
        const activeServerDir = join(scratch, 'dropped-state');
        const store = createPileStore({ activeServerDir });
        const first = join(scratch, 'first-drop'); const second = join(scratch, 'second-drop');
        await writeFile(first, 'first'); await writeFile(second, 'second');
        await store.set('owner', { add: [await ref(first), await ref(second)] }, actor);
        await rename(first, `${first}-gone`);
        const dropped = [{ itemId: first, path: first, reason: { code: 'missing' } }];
        expect((await store.get('owner')).droppedSinceLastView).toEqual(dropped);
        expect((await store.get('owner')).droppedSinceLastView).toEqual(dropped);
        const reopened = createPileStore({ activeServerDir });
        expect((await reopened.get('owner')).droppedSinceLastView).toEqual(dropped);
        await store.set('other', { acknowledgeDropped: [first] }, { accountId: 'other', kind: 'person' });
        expect((await store.get('owner')).droppedSinceLastView).toEqual(dropped);
        await rename(second, `${second}-gone`);
        await store.set('owner', { acknowledgeDropped: [first] }, actor);
        // Acknowledging the displayed drop preserves a different drop discovered meanwhile.
        expect((await store.get('owner')).droppedSinceLastView.map(item => item.itemId)).toEqual([second]);
        await reopened.set('owner', { acknowledgeDropped: [second] }, actor);
        expect((await store.get('owner')).droppedSinceLastView).toEqual([]);
        expect((await reopened.get('owner')).droppedSinceLastView).toEqual([]);
    });

    it('remembers declines until allocated bytes or last-change day changes', async () => {
        const path = join(scratch, 'decline'); await writeFile(path, 'one');
        const item = { ref: await ref(path), size: { ...zero, allocatedBytes: 4096 }, lastChangedAt: 86_400_000 };
        const store = createPileStore({ activeServerDir: join(scratch, 'decline-state') });
        await store.decline('owner', [item]);
        expect(await store.isDeclined('owner', item)).toBe(true);
        expect(await store.isDeclined('other', item)).toBe(false);
        expect(await store.isDeclined('owner', { ...item, lastChangedAt: 2 * 86_400_000 })).toBe(false);
        expect(await store.isDeclined('owner', { ...item, size: { ...zero, allocatedBytes: 8192 } })).toBe(false);
        await store.decline('owner', [item]);
        await rename(path, `${path}-old`); await writeFile(path, 'replacement');
        expect(await store.isDeclined('owner', item)).toBe(false);
    });

    it('publishes only changed pile and decline facts, including pruning and expiry', async () => {
        const path = join(scratch, 'publication-item'); await writeFile(path, 'retained');
        let publications = 0;
        const store = createPileStore({ activeServerDir: join(scratch, 'publication-state'), now: () => 1,
            onChanged: () => { publications++; } });
        await store.set('owner', { clear: true }, actor);
        await store.removeActed('owner', ['missing']); await store.decline('owner', []);
        expect(publications).toBe(0);
        const selected = await ref(path);
        await store.set('owner', { add: [selected] }, actor);
        expect(publications).toBe(1);
        await store.set('owner', { clear: true, add: [selected] }, actor);
        expect(publications).toBe(1);
        await store.set('owner', { add: [selected] }, actor);
        expect(publications).toBe(1);
        const declined = { ref: selected, size: zero };
        await store.decline('owner', [declined]); expect(publications).toBe(2);
        await store.decline('owner', [declined]); expect(publications).toBe(2);
        await store.decline('owner', [{ ...declined, size: { ...zero, allocatedBytes: 4_096 } }, declined]);
        expect(publications).toBe(2);
        expect(await store.isDeclined('owner', { ...declined, size: { ...zero, allocatedBytes: 4096 } })).toBe(false);
        expect(publications).toBe(3);
        await rename(path, `${path}-gone`);
        expect((await store.get('owner')).items).toEqual([]); expect(publications).toBe(4);
        await store.get('owner'); expect(publications).toBe(4);
        await store.set('owner', { acknowledgeDropped: [path] }, actor); expect(publications).toBe(5);
        const surviving = await ref(`${path}-gone`);
        await store.set('owner', { add: [surviving] }, actor); expect(publications).toBe(6);
        await store.removeActed('owner', [surviving.itemId]); expect(publications).toBe(7);
        expect((await store.get('owner')).items).toEqual([]);
        await store.removeActed('owner', [surviving.itemId]); expect(publications).toBe(7);
    });

    it('does no full-history serialization for absent or unchanged declines and persists one actual expiry', async () => {
        const path = join(scratch, 'decline-cost-item'); await writeFile(path, 'retained');
        const selected = await ref(path);
        let publications = 0;
        const activeServerDir = join(scratch, 'decline-cost-state');
        const store = createPileStore({ activeServerDir, onChanged: () => { publications++; } });
        // Reuse the catalog's 1,000-retained-sibling scale, not a product capacity limit.
        const history = Array.from({ length: 1_000 }, (_, index) => ({
            ref: { ...selected, itemId: `retained-${index}` }, size: zero,
        }));
        await store.decline('owner', history);
        publications = 0;
        // Observe the real JSON encoder without replacing the store or its persistence logic.
        const encoded = vi.spyOn(JSON, 'stringify');
        const stateEncodes = () => encoded.mock.calls.filter(([value]) => value !== null && typeof value === 'object'
            && 'items' in value && 'declined' in value && 'dropped' in value).length;
        try {
            for (let observation = 0; observation < 3; observation++) {
                expect(await store.isDeclined('owner', { ref: { ...selected, itemId: 'new-candidate' }, size: zero })).toBe(false);
                expect(await store.isDeclined('owner', history[0]!)).toBe(true);
            }
            await store.set('owner', { clear: true }, actor);
            await store.removeActed('owner', ['missing']);
            await store.decline('owner', [history[0]!]);
            await store.get('owner');
            expect(stateEncodes()).toBe(0);
            expect(publications).toBe(0);
            expect(await store.isDeclined('owner', { ...history[0]!, size: { ...zero, allocatedBytes: 4_096 } })).toBe(false);
            expect(stateEncodes()).toBe(1);
            expect(publications).toBe(1);
            const reopened = createPileStore({ activeServerDir });
            expect(await reopened.isDeclined('owner', history[0]!)).toBe(false);
            expect(await reopened.isDeclined('owner', history[1]!)).toBe(true);
            expect(stateEncodes()).toBe(1);
        } finally { encoded.mockRestore(); }
    });

    async function fixtures(name: string) {
        const home = join(scratch, `${name}-home`); await mkdir(home);
        const candidates = join(scratch, `${name}-items`); await mkdir(candidates);
        const fingerprints = new Map<string, string>(); const verdicts = new Map<string, StorageCategoryItem['verdict']>();
        const activityLog = await createActivityLog({ activeServerDir: home,
            resourceSummary: { reportAutomaticAction: () => { throw new Error('Trash must not publish guard actions'); } } });
        const trash = createTrashStore({ happyHomeDir: home, osUserId: String(process.getuid?.() ?? 1),
            target: { machineId: 'fixture' },
            readVolumes: () => [{ id: 'fixture', mount: scratch }],
            activityLog,
            attributionFor: () => ({ kind: 'unknown' }), classifyRestorePath: async () => null, readEmptyAfterDays: () => null,
            resolveOwnerAdapter: async (_categoryId, data) => filesystemAdapterForEntry(data) });
        const deps: PileReviewDeps = {
            resolve: async supplied => ({ item: { itemId: supplied.itemId, path: supplied.path, categoryId: 'logs',
                kind: 'category-item', title: supplied.itemId, evidence: [], verdict: verdicts.get(supplied.itemId) ?? 'safe',
                reason: { code: 'old' }, collectable: true }, fingerprint: fingerprints.get(supplied.itemId) }),
            classify: async (_physical, item) => ({ verdict: verdicts.get(item.itemId) ?? 'safe', reason: { code: verdicts.get(item.itemId) === 'forbidden' ? 'system' : 'old' } }),
            measure: measureNativeDisk, trashAvailability: trash.availability,
        };
        const adapter = async (item: StorageCleanupItem): Promise<StorageCategoryAdapter> => bindFilesystemItem(item);
        return { candidates, deps, trash, adapter, fingerprints, verdicts, activityLog };
    }

    it('reviews one reduced union and ignores size growth in expect while rejecting identity/fingerprint changes', async () => {
        const f = await fixtures('review'); const folder = join(f.candidates, 'folder'); await mkdir(folder);
        const child = join(folder, 'child'); await writeFile(child, Buffer.alloc(4096));
        const refs = [await ref(child), await ref(folder)];
        const initial = await reviewPile(refs, f.deps);
        expect(initial.items).toHaveLength(1); expect(initial.items[0]?.absorbs).toEqual([child]);
        const folderUnion = await measureNativeDisk({ paths: [folder], measureSharedExtents: true });
        expect(initial.totalFreesBytes).toBe(folderUnion.totalExclusiveBytes);
        expect(initial.items[0]?.size.allocatedBytes).toBe(folderUnion.totalAllocatedBytes);
        expect(initial.countedOnceBytes).toBe((await measureNativeDisk({ paths: [child], measureSharedExtents: true })).totalAllocatedBytes);
        await appendFile(child, Buffer.alloc(8192));
        expect((await reviewPile(refs, f.deps)).items[0]?.expect).toBe(initial.items[0]?.expect);
        f.fingerprints.set(folder, 'changed');
        expect((await reviewPile(refs, f.deps)).items[0]?.expect).not.toBe(initial.items[0]?.expect);
        await rename(folder, `${folder}-old`); await symlink(`${folder}-old`, folder, process.platform === 'win32' ? 'junction' : 'dir');
        expect(await reviewPile(refs, f.deps)).toMatchObject({ items: [], staying: expect.arrayContaining([expect.objectContaining({ reason: { code: 'changed_since_review' } })]) });
    });

    it('counts cross-directory hard links once as a union and excludes a Forbidden outside link from frees', async () => {
        const f = await fixtures('links'); const a = join(f.candidates, 'a'); const b = join(f.candidates, 'b');
        await mkdir(a); await mkdir(b); const file = join(a, 'file'); await writeFile(file, Buffer.alloc(8192)); await link(file, join(b, 'file'));
        const refs = [await ref(a), await ref(b)];
        const union = await measureNativeDisk({ paths: [a, b], measureSharedExtents: true });
        expect((await reviewPile(refs, f.deps)).totalFreesBytes).toBe(union.totalExclusiveBytes);
        f.verdicts.set(b, 'forbidden');
        expect((await reviewPile(refs, f.deps)).totalFreesBytes).toBe((await measureNativeDisk({ paths: [a], measureSharedExtents: true })).totalExclusiveBytes);
    });

    it('moves Safe/Caution/Keep approved items, skips changed ones, refuses Forbidden, reports actual bytes and empties only its new batch', async () => {
        const f = await fixtures('apply');
        const refs: PileItemRefV1[] = [];
        for (const name of ['safe', 'caution', 'keep', 'changed', 'forbidden', 'prior']) {
            const path = join(f.candidates, name); await writeFile(path, Buffer.alloc(4096, 7)); refs.push(await ref(path));
            if (name === 'caution' || name === 'keep' || name === 'forbidden') f.verdicts.set(path, name);
        }
        const authority = async () => {};
        const deps = { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter };
        const prior = await reviewPile([refs[5]!], f.deps);
        await applyPile({ items: prior.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: authority }, deps);
        const review = await reviewPile(refs.slice(0, 5), f.deps);
        await appendFile(refs[0]!.path, Buffer.alloc(16384, 8));
        f.fingerprints.set(refs[3]!.path, 'changed');
        const actual = (await measureNativeDisk({ paths: [refs[0]!.path, refs[1]!.path, refs[2]!.path], measureSharedExtents: true })).totalAllocatedBytes;
        const result = await applyPile({ items: review.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: authority }, deps);
        expect(result.outcomes.map(outcome => outcome.status)).toEqual(['moved', 'moved', 'moved', 'skipped', 'refused']);
        expect(result.inTrashBytes).toBe(actual); expect(result.freedBytes).toBe(0);
        const receipt = PileApplyResultV1Schema.parse(result);
        expect(receipt.trashEntryIds?.slice().sort()).toEqual((await f.trash.list({ batchId: result.batchId })).map(entry => entry.entryId).sort());
        expect(await readFile((await f.trash.list({ batchId: result.batchId }))[0]!.originalPath).catch(() => null)).toBeNull();
        const extra = join(f.candidates, 'extra'); await writeFile(extra, Buffer.alloc(4096));
        const extraReview = await reviewPile([await ref(extra)], f.deps);
        const emptied = await applyPile({ items: extraReview.items, mode: 'trash', actor, custodianAccountId: 'owner', emptyAfter: true, assertCurrentAuthority: authority }, deps);
        expect(emptied.inTrashBytes).toBe(0); expect(emptied.freedBytes).toBeGreaterThan(0);
        const emptiedReceipt = PileApplyResultV1Schema.parse(emptied);
        expect(emptiedReceipt.trashEntryIds).toEqual([]);
        const emptyActivity = (await f.activityLog.list({ range: '30d' })).entries.filter(row => row.kind === 'trash_emptied');
        expect(emptyActivity).toEqual([expect.objectContaining({ kind: 'trash_emptied', freedBytes: emptied.freedBytes })]);
        expect(await f.trash.list()).toHaveLength(4);
    });

    it('reports one physical allocation for separately moved hardlinks, including growth after review', async () => {
        const f = await fixtures('move-links'); const first = join(f.candidates, 'first'); const second = join(f.candidates, 'second');
        await writeFile(first, Buffer.alloc(8192)); await link(first, second);
        const checked = await reviewPile([await ref(first), await ref(second)], f.deps);
        await appendFile(first, Buffer.alloc(4096));
        const actual = await measureNativeDisk({ paths: [first, second], measureSharedExtents: true });
        const result = await applyPile({ items: checked.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: async () => {} },
            { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter });
        expect(result.outcomes).toEqual([first, second].map(itemId => ({ itemId, status: 'moved' })));
        expect(result.inTrashBytes).toBe(actual.totalAllocatedBytes); expect(result.freedBytes).toBe(0);
        expect(await f.trash.list({ batchId: result.batchId })).toHaveLength(2);
        const nextFirst = join(f.candidates, 'next-first'); const nextSecond = join(f.candidates, 'next-second');
        await writeFile(nextFirst, Buffer.alloc(4096)); await link(nextFirst, nextSecond);
        const nextChecked = await reviewPile([await ref(nextFirst), await ref(nextSecond)], f.deps);
        const nextActual = await measureNativeDisk({ paths: [nextFirst, nextSecond], measureSharedExtents: true });
        const emptied = await applyPile({ items: nextChecked.items, mode: 'trash', actor, custodianAccountId: 'owner', emptyAfter: true, assertCurrentAuthority: async () => {} },
            { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter });
        expect(emptied.inTrashBytes).toBe(0); expect(emptied.freedBytes).toBe(nextActual.totalExclusiveBytes);
        expect(await f.trash.list()).toHaveLength(2);
    });

    it('correlates only the entries remaining after a real partial immediate empty', async () => {
        const f = await fixtures('partial-immediate-empty');
        const paths = ['first', 'second'].map(name => join(f.candidates, name));
        for (const path of paths) await writeFile(path, Buffer.alloc(8192, 3));
        const checked = await reviewPile(await Promise.all(paths.map(ref)), f.deps);
        let remainingId: string | undefined;
        let remainingPath: string | undefined;
        // Replace one payload only after both moves commit, at the real pre-empty authority boundary.
        // The actual Trash owner must refuse its changed identity while emptying the other entry.
        const assertCurrentAuthority = async (item: StorageCleanupItem) => {
            if (remainingId) return;
            const entries = await f.trash.list();
            if (entries.length !== 2) return;
            const entry = entries.find(value => value.originalPath === item.path)!;
            remainingId = entry.entryId;
            remainingPath = entry.originalPath;
            const root = (await f.trash.roots()).find(value => value.volumeId === entry.volumeId)!;
            const payload = join(root.path, entry.entryId, 'payload');
            await rename(payload, `${payload}-retained`);
            await writeFile(payload, Buffer.alloc(8192, 4));
        };
        const result = PileApplyResultV1Schema.parse(await applyPile({ items: checked.items, mode: 'trash', actor,
            custodianAccountId: 'owner', emptyAfter: true, assertCurrentAuthority },
        { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter }));
        expect(result.trashEntryIds).toEqual([remainingId]);
        expect((await f.trash.list()).map(entry => entry.entryId)).toEqual([remainingId]);
        const activity = (await f.activityLog.list({ range: '30d' })).entries;
        expect(activity.filter(entry => entry.kind === 'trash_emptied')).toEqual([
            expect.objectContaining({ freedBytes: result.freedBytes }),
        ]);
        expect(result.freedBytes).toBeGreaterThan(0);
        expect(result.outcomes).toEqual(paths.map(itemId => ({ itemId, status: 'moved',
            ...(itemId === remainingPath ? { reason: { code: 'changed_since_review' } } : {}) })));
    });

    it('checks changed facts and revoked authority after an owner wait immediately before effect', async () => {
        const f = await fixtures('late'); const path = join(f.candidates, 'late'); await writeFile(path, 'preserved');
        const checked = await reviewPile([await ref(path)], f.deps);
        let current = true;
        const assertCurrentAuthority = async () => { if (!current) throw Object.assign(new Error('Revoked'), { code: 'unauthorized' }); };
        const deps = { ...f.deps, trashStore: f.trash, resolveAdapter: async (item: StorageCleanupItem) => {
            const adapter = await f.adapter(item);
            return { ...adapter, retire: async (input: Parameters<StorageCategoryAdapter['retire']>[0]) => {
                current = false; await adapter.retire(input);
            } };
        } };
        const result = await applyPile({ items: checked.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority }, deps);
        expect(result.outcomes).toEqual([{ itemId: path, status: 'skipped', reason: { code: 'unauthorized' } }]);
        expect(await readFile(path, 'utf8')).toBe('preserved');
        current = true;
        const deletion = await applyPile({ items: checked.items, mode: 'delete', actor, custodianAccountId: 'owner', assertCurrentAuthority },
            { ...f.deps, trashStore: f.trash, resolveAdapter: async item => {
                const adapter = await f.adapter(item);
                return { ...adapter, discard: async (input: Parameters<StorageCategoryAdapter['discard']>[0]) => {
                    f.fingerprints.set(path, 'late-change'); await adapter.discard(input);
                } };
            } });
        expect(deletion.outcomes).toEqual([{ itemId: path, status: 'skipped', reason: { code: 'changed_since_review' } }]);
        expect(await readFile(path, 'utf8')).toBe('preserved');
        f.verdicts.set(path, 'keep');
        const currentReview = await reviewPile([await ref(path)], f.deps);
        const removed = await applyPile({ items: currentReview.items, mode: 'delete', actor, custodianAccountId: 'owner', assertCurrentAuthority },
            { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter });
        expect(removed.outcomes).toEqual([{ itemId: path, status: 'deleted' }]);
        expect(removed.freedBytes).toBeGreaterThan(0); expect(removed.inTrashBytes).toBe(0);
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserves moved outcomes when authority is revoked before the requested batch empty', async () => {
        const f = await fixtures('empty-revoked'); const path = join(f.candidates, 'item'); await writeFile(path, Buffer.alloc(4096));
        const checked = await reviewPile([await ref(path)], f.deps);
        const assertCurrentAuthority = async () => {
            try { await lstat(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error('Revoked'), { code: 'unauthorized' }); throw error; }
        };
        const result = await applyPile({ items: checked.items, mode: 'trash', actor, custodianAccountId: 'owner', emptyAfter: true, assertCurrentAuthority },
            { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter });
        expect(result.outcomes).toEqual([{ itemId: path, status: 'moved', reason: { code: 'unauthorized' } }]);
        expect(result.inTrashBytes).toBeGreaterThan(0); expect(result.freedBytes).toBe(0);
        expect(await f.trash.list({ batchId: result.batchId })).toHaveLength(1);
    });

    it('reports completed effects when the canonical pile-state write fails afterward', async () => {
        const f = await fixtures('pile-write-failed'); const path = join(f.candidates, 'item'); await writeFile(path, Buffer.alloc(4096));
        const stateDir = join(scratch, 'pile-write-failed-state');
        const store = createPileStore({ activeServerDir: stateDir });
        const stored = await store.set(actor.accountId, { add: [await ref(path)] }, actor);
        const checked = await reviewPile(stored.items, f.deps);
        const result = await applyPile({ items: checked.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: async () => {} },
            { ...f.deps, trashStore: f.trash, removeActed: store.removeActed, resolveAdapter: async item => {
                const adapter = await f.adapter(item);
                return { ...adapter, retire: async input => {
                    await adapter.retire(input);
                    await rename(stateDir, `${stateDir}-old`); await writeFile(stateDir, 'not a directory');
                } };
            } });
        expect(result.outcomes).toEqual([{ itemId: path, status: 'moved', reason: { code: 'operation_failed' } }]);
        expect(result.inTrashBytes).toBeGreaterThan(0); expect(result.freedBytes).toBe(0);
        expect(await f.trash.list({ batchId: result.batchId })).toHaveLength(1);
    });

    it('cannot certify unchanged owner data when its required fingerprint is unavailable', async () => {
        const f = await fixtures('unavailable-fingerprint'); const path = join(f.candidates, 'item'); await writeFile(path, 'preserved');
        const reference = await ref(path);
        const deps = { ...f.deps, resolve: async (ref: PileItemRefV1) => {
            const resolved = await f.deps.resolve(ref); return resolved ? { ...resolved, fingerprintRequired: true } : null;
        } };
        expect(await reviewPile([reference], deps)).toMatchObject({ items: [], staying: [{ reason: { code: 'facts_unavailable' } }] });
        const original = await reviewPile([reference], f.deps);
        const result = await applyPile({ items: original.items, mode: 'delete', actor, custodianAccountId: 'owner', assertCurrentAuthority: async () => {} },
            { ...deps, trashStore: f.trash, resolveAdapter: f.adapter });
        expect(result.outcomes).toEqual([{ itemId: path, status: 'skipped', reason: { code: 'facts_unavailable' } }]);
        expect(await readFile(path, 'utf8')).toBe('preserved');
    });

    async function nestedFixture(name: string) {
        const f = await fixtures(name);
        const parent = join(f.candidates, 'parent'); const child = join(parent, 'child'); const grandchild = join(child, 'grandchild');
        await mkdir(grandchild, { recursive: true });
        for (const path of [parent, child, grandchild]) { await writeFile(join(path, 'content'), path); f.fingerprints.set(path, path); }
        const paths = [parent, child, grandchild];
        const deps: PileReviewDeps = { ...f.deps, resolve: async reference => {
            const base = await f.deps.resolve(reference); if (!base) return null;
            const items: StorageCategoryItem[] = [];
            for (const path of paths) {
                try { await lstat(path); }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
                const candidate = await f.deps.resolve(await ref(path));
                if (candidate) items.push({ ...candidate.item, categoryId: 'logs', fingerprint: f.fingerprints.get(path), ownFingerprint: f.fingerprints.get(path), fingerprintRequired: true });
            }
            return { ...base, fingerprintRequired: true, ownFingerprint: base.fingerprint,
                retirementChildren: items.filter(item => item.path.startsWith(`${reference.path}/`)) };
        } };
        return { ...f, deps, parent, child, grandchild };
    }

    it('retires canonical nested children deepest first with separate entries in one approved batch', async () => {
        const f = await nestedFixture('nested');
        const review = await reviewPile([await ref(f.parent)], f.deps);
        const result = await applyPile({ items: review.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: async () => {} },
            { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter });
        expect(result.outcomes).toEqual([f.grandchild, f.child, f.parent].map(itemId => ({ itemId, status: 'moved' })));
        expect(await f.trash.list({ batchId: result.batchId })).toHaveLength(3);
        const undo = await f.trash.restore({ batchId: result.batchId }, { actorAccountId: actor.accountId });
        expect(undo.outcomes.map(outcome => outcome.path)).toEqual([f.parent, f.child, f.grandchild]);
        expect(undo.outcomes.every(outcome => outcome.status === 'restored')).toBe(true);
        for (const path of [f.parent, f.child, f.grandchild]) expect(await readFile(join(path, 'content'), 'utf8')).toBe(path);
    });

    it('rejects an edited nested child before any effect on its reviewed parent', async () => {
        const f = await nestedFixture('nested-changed');
        const review = await reviewPile([await ref(f.parent)], f.deps);
        f.fingerprints.set(f.grandchild, 'changed-after-review');
        const result = await applyPile({ items: review.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: async () => {} },
            { ...f.deps, trashStore: f.trash, resolveAdapter: f.adapter });
        expect(result.outcomes).toEqual([{ itemId: f.parent, status: 'skipped', reason: { code: 'changed_since_review' } }]);
        expect(await f.trash.list()).toEqual([]); expect(await readFile(join(f.grandchild, 'content'), 'utf8')).toBe(f.grandchild);
    });

    it('preserves successful nested moves when the next owned child fails', async () => {
        const f = await nestedFixture('nested-partial');
        const review = await reviewPile([await ref(f.parent)], f.deps);
        const result = await applyPile({ items: review.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: async () => {} },
            { ...f.deps, trashStore: f.trash, resolveAdapter: async item => {
                const adapter = await f.adapter(item);
                return { ...adapter, retire: async input => {
                    if (item.itemId === f.child) throw new Error('Owner could not retire its child');
                    await adapter.retire(input);
                } };
            } });
        expect(result.outcomes).toEqual([
            { itemId: f.grandchild, status: 'moved' },
            { itemId: f.child, status: 'failed', reason: { code: 'operation_failed' } },
            { itemId: f.parent, status: 'skipped', reason: { code: 'facts_unavailable', detail: { itemId: f.child } } },
        ]);
        expect(await f.trash.list({ batchId: result.batchId })).toHaveLength(1);
        expect(await readFile(join(f.child, 'content'), 'utf8')).toBe(f.child);
    });

    it('rejects a recreated child during the expected parent continuation', async () => {
        const f = await nestedFixture('nested-recreated');
        const review = await reviewPile([await ref(f.parent)], f.deps);
        const result = await applyPile({ items: review.items, mode: 'trash', actor, custodianAccountId: 'owner', assertCurrentAuthority: async () => {} },
            { ...f.deps, trashStore: f.trash, resolveAdapter: async item => {
                const adapter = await f.adapter(item);
                return { ...adapter, retire: async input => {
                    await adapter.retire(input);
                    if (item.itemId === f.grandchild) { await mkdir(f.grandchild); await writeFile(join(f.grandchild, 'new'), 'new owner data'); }
                } };
            } });
        expect(result.outcomes).toEqual([
            { itemId: f.grandchild, status: 'moved' },
            { itemId: f.parent, status: 'skipped', reason: { code: 'changed_since_review' } },
        ]);
        expect(await f.trash.list({ batchId: result.batchId })).toHaveLength(1);
        expect(await readFile(join(f.grandchild, 'new'), 'utf8')).toBe('new owner data');
    });
});
