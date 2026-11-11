import { describe, expect, it } from 'vitest';
import type { HappierStorageSummaryV1 } from '@happier-dev/protocol/storage/storageV1';

import { describeStorageVerdict, storageReasonLabel, storageCategoryTitle } from './storageReasonPresentation';
import { parseCustomScanTime, parseCustomStorageDays } from './storageTidyChoices';
import {
    buildStorageRing,
    describeStorageCategoryTrailing,
    describeStorageSentence,
    formatStorageSize,
    isStorageCategoryPartial,
    orderStorageCategories,
    resolveStorageVolumeParts,
    selectStorageTabView,
    storageVolumeName,
} from './storageViewModel';

const GB = 1_000_000_000;
type Category = HappierStorageSummaryV1['categories'][number];

function category(categoryId: Category['categoryId'], bytes: number, canGoBytes = 0, count = 1, detailFacts: Category['detailFacts'] = {}): Category {
    return { categoryId, size: { allocatedBytes: bytes, freesBytes: canGoBytes, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false },
        canGoBytes, count, detailFacts };
}

function summary(overrides: Partial<HappierStorageSummaryV1> = {}): HappierStorageSummaryV1 {
    return {
        revision: 1, sizedAt: 1_000,
        volumes: [
            { volume: { volumeId: 'mac', mountPath: '/', label: 'Macintosh HD' }, totalBytes: 994 * GB, freeBytes: 412 * GB, happierBytes: 96 * GB, pileBytes: 0, trashBytes: 0 },
            { volume: { volumeId: 'work', mountPath: '/Volumes/Work', label: 'Work' }, totalBytes: 2_000 * GB, freeBytes: 1_200 * GB, happierBytes: 0, pileBytes: 0, trashBytes: 0 },
        ],
        categories: [
            category('caches', 17.6 * GB, 17 * GB, 12),
            category('worktrees', 58.4 * GB, 23.8 * GB, 192),
            category('agentHomes', 1.9 * GB, 0, 2, { keepCount: 2 }),
            category('modelPacks', 7.4 * GB, 2.1 * GB, 4),
            category('recordings', 0, 0, 0),
            category('logs', 4.3 * GB, 3.1 * GB, 9),
            category('trash', 0, 0, 0),
        ],
        suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 },
        wholeDisk: { enabled: false, scans: [] },
        ...overrides,
    };
}

describe('the Storage tab state (STO-24)', () => {
    it('keeps last-known sizes offline and through a failed re-size, and waits on reserved boxes before the first', () => {
        const known = summary();
        expect(selectStorageTabView({ status: 'loading', enabled: false, summary: null, offline: false, recipient: false })).toEqual({ kind: 'waiting' });
        expect(selectStorageTabView({ status: 'loading', enabled: false, summary: null, offline: true, recipient: false })).toEqual({ kind: 'offline_empty' });
        expect(selectStorageTabView({ enabled: true, status: 'not_reported', summary: known, offline: false, recipient: false })).toEqual({ kind: 'not_reported' });
        expect(selectStorageTabView({ enabled: true, status: 'loading', summary: null, offline: false, recipient: false })).toEqual({ kind: 'loading' });
        expect(selectStorageTabView({ enabled: true, status: 'error', summary: null, offline: false, recipient: false })).toEqual({ kind: 'error' });
        expect(selectStorageTabView({ enabled: true, status: 'loading', summary: null, offline: true, recipient: false })).toEqual({ kind: 'offline_empty' });
        expect(selectStorageTabView({ enabled: true, status: 'error', summary: known, offline: false, recipient: true }))
            .toMatchObject({ kind: 'ready', summary: known, stale: true, offline: false, recipient: true });
        // Offline, an old summary is last known, not a failure.
        expect(selectStorageTabView({ enabled: true, status: 'error', summary: known, offline: true, recipient: false })).toMatchObject({ kind: 'ready', stale: false, offline: true });
    });
    it('keeps the last good sizes while the machine\u2019s resources policy is unavailable, and offers no cleanup claims', () => {
        const known = summary();
        expect(selectStorageTabView({ enabled: true, status: 'policy_unavailable', summary: known, offline: false, recipient: false }))
            .toMatchObject({ kind: 'ready', summary: known, policyUnavailable: true, stale: false });
        expect(selectStorageTabView({ enabled: true, status: 'policy_unavailable', summary: null, offline: false, recipient: false })).toEqual({ kind: 'policy_unavailable' });
        expect(selectStorageTabView({ enabled: true, status: 'ready', summary: known, offline: false, recipient: false })).toMatchObject({ policyUnavailable: false });
        expect(describeStorageSentence(known, { recipient: false, policyUnavailable: true }).canGoBytes).toBeNull();
    });
});

describe('the sentence and the disks (STO-1)', () => {
    it('keeps allocated ghosts separate from exclusive cleanup gains and never forecasts unreported frees', () => {
        const volume = { ...summary().volumes[0]!, pileBytes: 20_480, pileFreesBytes: 4_096, trashBytes: 20_480, trashFreesBytes: 0 };
        expect(resolveStorageVolumeParts(volume)).toMatchObject({ pile: 20_480, trash: 20_480,
            afterCleanupFree: volume.freeBytes + 4_096, afterTrashFree: volume.freeBytes });
        const moved = { ...volume, pileBytes: 0, pileFreesBytes: 0, trashFreesBytes: 4_096 };
        expect(resolveStorageVolumeParts(moved)).toMatchObject({ afterCleanupFree: null, afterTrashFree: volume.freeBytes + 4_096 });
        const retained = summary({ volumes: [moved], categories: [category('trash', 20_480, 4_096)], trash: { count: 1, allocatedBytes: 20_480 } });
        expect(describeStorageSentence(retained, { recipient: false }).trashBytes).toBe(4_096);
        expect(resolveStorageVolumeParts({ ...summary().volumes[0]!, pileBytes: 20_480, trashBytes: 20_480 }))
            .toMatchObject({ afterCleanupFree: null, afterTrashFree: null });
    });
    it('speaks of the disk holding Happier, and of what can go only to the person who manages the machine', () => {
        expect(describeStorageSentence(summary(), { recipient: false })).toEqual({
            freeBytes: 412 * GB, happierBytes: 96 * GB, where: { kind: 'volume', label: 'Macintosh HD' }, canGoBytes: 46 * GB,
            trashBytes: 0, trashEmptiesAt: null,
        });
        expect(describeStorageSentence(summary(), { recipient: true }).canGoBytes).toBeNull();
        const spread = summary({ volumes: summary().volumes.map(volume => ({ ...volume, happierBytes: 10 * GB })) });
        expect(describeStorageSentence(spread, { recipient: false }).where).toEqual({ kind: 'across', count: 2 });
    });

    it('names a disk by its label, an unnamed root as the system disk, and any other disk by its mount', () => {
        const [mac, work] = summary().volumes;
        expect(storageVolumeName(mac!)).toBe('Macintosh HD');
        expect(storageVolumeName({ ...mac!, volume: { volumeId: 'root', mountPath: '/', label: '' } })).toBe('System disk');
        // Linux reports the root's mount path as its label: still the system disk, never a bare slash.
        expect(storageVolumeName({ ...mac!, volume: { volumeId: 'root', mountPath: '/', label: '/' } })).toBe('System disk');
        expect(storageVolumeName({ ...work!, volume: { volumeId: 'w', mountPath: '/mnt/work', label: '' } })).toBe('/mnt/work');
    });

    it('draws the pile as a ghost carved from Happier’s share and says the free space after cleanup', () => {
        const volume = { ...summary().volumes[0]!, pileBytes: 37.9 * GB, pileFreesBytes: 37.9 * GB };
        expect(resolveStorageVolumeParts(volume)).toEqual({
            everythingElse: 486 * GB, happier: 96 * GB - 37.9 * GB, pile: 37.9 * GB, trash: 0, free: 412 * GB, purgeable: null, afterCleanupFree: 412 * GB + 37.9 * GB,
            afterTrashFree: null,
        });
        // Reported figures that overlap never make a part negative or exceed the disk.
        expect(resolveStorageVolumeParts({ ...volume, freeBytes: 990 * GB, happierBytes: 50 * GB, pileBytes: 80 * GB }))
            .toEqual({ everythingElse: 0, happier: 0, pile: 4 * GB, trash: 0, free: 990 * GB, purgeable: null, afterCleanupFree: 994 * GB, afterTrashFree: null });
        expect(resolveStorageVolumeParts(summary().volumes[1]!).afterCleanupFree).toBeNull();
    });

    it('after a move to Trash, draws what is in the Trash as its own ghost and says what comes back when it empties (lab RD)', () => {
        const volume = { ...summary().volumes[0]!, trashBytes: 34.5 * GB, trashFreesBytes: 34.5 * GB };
        expect(resolveStorageVolumeParts(volume)).toMatchObject({ happier: 96 * GB - 34.5 * GB, pile: 0, trash: 34.5 * GB,
            afterCleanupFree: null, afterTrashFree: 412 * GB + 34.5 * GB });
        const moved = summary({ volumes: [volume, summary().volumes[1]!], trash: { count: 6, allocatedBytes: 34.5 * GB, emptiesNextAt: 9_000 } });
        expect(describeStorageSentence(moved, { recipient: false })).toMatchObject({ trashBytes: 34.5 * GB, trashEmptiesAt: 9_000 });
        // A person who only uses the machine is not told about its Trash.
        expect(describeStorageSentence(moved, { recipient: true }).trashBytes).toBe(0);
    });

    it('carves reclaimable capacity from everything else while free-now and cleanup gains stay exact', () => {
        const volume = { ...summary().volumes[0]!, pileBytes: 20 * GB, pileFreesBytes: 20 * GB, availableIncludingPurgeableBytes: 462 * GB };
        const parts = resolveStorageVolumeParts(volume);
        expect(parts).toMatchObject({ purgeable: 50 * GB, everythingElse: 436 * GB, free: 412 * GB, afterCleanupFree: 432 * GB });
        if (parts.purgeable === null) throw new Error('The sampled reclaimable capacity must stay reported');
        expect(parts.everythingElse + parts.happier + parts.pile + parts.trash + parts.free + parts.purgeable).toBe(volume.totalBytes);
        expect(resolveStorageVolumeParts({ ...volume, availableIncludingPurgeableBytes: volume.freeBytes }).purgeable).toBe(0);
        expect(resolveStorageVolumeParts(summary().volumes[1]!).purgeable).toBeNull();
        expect(resolveStorageVolumeParts({ ...volume, availableIncludingPurgeableBytes: 2_000 * GB })).toMatchObject({ everythingElse: 0, purgeable: 486 * GB });
    });
});

describe('the breakdown and its ring (STO-2, STO-5)', () => {
    it('lists kinds biggest first, recordings only once there are some, each with what can go or that it is kept', () => {
        const known = summary({ trash: { count: 3, allocatedBytes: GB, emptiesNextAt: 5_000 } });
        const order = orderStorageCategories(known).map(entry => entry.categoryId);
        expect(order).toEqual(['worktrees', 'caches', 'modelPacks', 'logs', 'agentHomes', 'trash']);
        // A kind holding nothing yet is folded away, as the lab lists only kinds with content.
        const empty = { ...known, categories: known.categories.map(entry => entry.categoryId === 'worktrees'
            ? { ...entry, count: 0, size: { ...entry.size, allocatedBytes: 0 } } : entry) };
        expect(orderStorageCategories(empty).map(entry => entry.categoryId)).not.toContain('worktrees');
        const byId = new Map(known.categories.map(entry => [entry.categoryId, entry]));
        expect(describeStorageCategoryTrailing(byId.get('worktrees')!, known)).toEqual({ kind: 'can_go', bytes: 23.8 * GB });
        expect(describeStorageCategoryTrailing(byId.get('agentHomes')!, known)).toEqual({ kind: 'always_kept' });
        expect(describeStorageCategoryTrailing({ ...byId.get('trash')!, count: 3 }, known)).toEqual({ kind: 'trash', emptiesAt: 5_000 });
        expect(describeStorageCategoryTrailing(byId.get('trash')!, known)).toEqual({ kind: 'none' });
    });

    it('rings three named kinds and the rest over what would be left, closing with the pile as its hatched arc', () => {
        const ring = buildStorageRing(summary({ pile: { count: 9, freesBytes: 38.4 * GB, droppedSinceLastView: [] } }));
        expect(ring.parts.map(part => part.id)).toEqual(['worktrees', 'caches', 'modelPacks', 'rest', 'pile']);
        expect(ring.parts.find(part => part.id === 'rest')?.bytes).toBeCloseTo((4.3 + 1.9) * GB);
        expect(ring.afterBytes).toBeCloseTo(57.6 * GB);
        const solid = ring.parts.filter(part => part.kind !== 'pile').reduce((sum, part) => sum + part.fraction, 0);
        expect(solid).toBeCloseTo(57.6 / 96, 6);
        expect(ring.parts.at(-1)).toMatchObject({ kind: 'pile', fraction: 0.4 });
        // With nothing collected the kinds close the ring by themselves.
        const whole = buildStorageRing(summary());
        expect(whole.parts.some(part => part.kind === 'pile')).toBe(false);
        expect(whole.parts.reduce((sum, part) => sum + part.fraction, 0)).toBeCloseTo(1, 6);
    });
});

describe('verdict chips (R42)', () => {
    it('names actual ownership limitations while retaining a generic unsupported fallback', () => {
        const generic = storageReasonLabel({ code: 'unsupported' });
        expect(storageReasonLabel({ code: 'unsupported', detail: { cause: 'main_checkout_lifecycle_unsupported', owner: 'scm', path: '/repo' } })).not.toBe(generic);
        for (const categoryId of ['sessionFolders', 'modelPacks', 'recordings'] as const) {
            const label = storageReasonLabel({ code: 'unsupported', detail: { cause: 'owner_requires_whole_item', categoryId, path: '/owned' } });
            expect(label).not.toBe(generic);
            expect(label).toContain(storageCategoryTitle(categoryId));
        }
        expect(storageReasonLabel({ code: 'unsupported', detail: { cause: 'future_owner', categoryId: 'invalid' } })).toBe(generic);
    });
    it('reads Forbidden and Keep with their reason, and never a Protected tier', () => {
        expect(describeStorageVerdict({ verdict: 'safe', reason: { code: 'downloads_again' } }))
            .toEqual({ variant: 'success', chrome: 'plain', icon: 'check-circle', label: 'Safe · downloads again', word: 'Safe', detail: 'downloads again' });
        // One chrome per verdict family: "Can delete" is good news too, so it reads chromeless like "Safe".
        expect(describeStorageVerdict({ verdict: 'safe', reason: { code: 'stopped' } })).toMatchObject({ variant: 'success', chrome: 'plain', label: 'Can delete · stopped' });
        expect(describeStorageVerdict({ verdict: 'caution', reason: { code: 'feature_waits' } })).toMatchObject({ variant: 'attention', label: 'Caution · a feature waits for it' });
        expect(describeStorageVerdict({ verdict: 'keep', reason: { code: 'in_use' } })).toMatchObject({ icon: 'lock', label: 'Keep · in use' });
        expect(describeStorageVerdict({ verdict: 'forbidden', reason: { code: 'system' } })).toMatchObject({ label: 'Forbidden · system location' });
        expect(describeStorageVerdict({ verdict: 'check', reason: { code: 'facts_unavailable' } })).toMatchObject({ label: 'Check first · not checked yet' });
        for (const verdict of ['safe', 'caution', 'keep', 'forbidden', 'check'] as const) {
            expect(describeStorageVerdict({ verdict, reason: { code: 'in_use' } }).label).not.toMatch(/protect/i);
        }
    });
});

describe('Custom… values (R43)', () => {
    it('takes any whole number of days from one, and a time of day', () => {
        expect(parseCustomStorageDays('45')).toBeNull();
        expect(parseCustomStorageDays('45 d')).toBe(45);
        expect(parseCustomStorageDays(' 400 days ')).toBe(400);
        expect(parseCustomStorageDays('1d')).toBe(1);
        expect(parseCustomStorageDays('0')).toBeNull();
        expect(parseCustomStorageDays('2.5')).toBeNull();
        expect(parseCustomStorageDays('48 h')).toBe(2);
        expect(parseCustomStorageDays('25 h')).toBeNull();
        expect(parseCustomStorageDays('9007199254740991 d')).toBe(Number.MAX_SAFE_INTEGER);
        expect(parseCustomStorageDays('9007199254740992 d')).toBeNull();
        expect(parseCustomScanTime('3:05')).toBe('03:05');
        expect(parseCustomScanTime('23:59')).toBe('23:59');
        expect(parseCustomScanTime('24:00')).toBeNull();
    });
});

describe('the lower-bound size (C2-9)', () => {
    it('says a figure the same way for a disk node, a category and an item row, with its "\u2265" only when it is a floor', () => {
        const exact = formatStorageSize(4_100, false);
        expect(formatStorageSize(4_100, true)).toBe(`\u2265 ${exact}`);
        expect(exact).not.toContain('\u2265');
        const partial = { ...category('caches', 4_100), size: { ...category('caches', 4_100).size, atLeast: true } };
        expect(isStorageCategoryPartial(partial)).toBe(true);
        expect(formatStorageSize(partial.size.allocatedBytes, isStorageCategoryPartial(partial))).toBe(formatStorageSize(4_100, true));
    });
});
