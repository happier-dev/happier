import type { HappierStorageCategoryIdV1, HappierStorageSummaryV1 } from '@happier-dev/protocol/storage/storageV1';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import type { MachineStorageState } from '@/sync/domains/machines/storage/machineStorageStore';
import type { MachineStorageFailure } from '@/sync/domains/machines/storage/machineRpc';
import { t } from '@/text';

/**
 * What the Happier view of the Storage tab says, decided from the machine's storage summary alone
 * (plan 40 STO-1/2/5, STO-24, lab `rs` H / HR / HRV). Nothing here reads a store or draws; the tab and
 * its pieces render these facts.
 */

export type StorageSummary = HappierStorageSummaryV1;
export type StorageVolume = StorageSummary['volumes'][number];
export type StorageCategory = StorageSummary['categories'][number];

// ── The tab's state (STO-24) ─────────────────────────────────────────────────────────────────────────

export type StorageTabView =
    | Readonly<{ kind: 'not_reported' }>
    /** The machine's resources policy cannot be read and nothing was sized before: nothing to show but the notice. */
    | Readonly<{ kind: 'policy_unavailable' }>
    /** First sizing in progress (never sized): the boxes are reserved. */
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'error'; failure?: MachineStorageState['failure'] }>
    | Readonly<{ kind: 'offline_empty' }>
    | Readonly<{
        kind: 'ready';
        summary: StorageSummary;
        /** The machine is away: last known sizes, nothing can change. */
        offline: boolean;
        /** Sizing again did not land; the sizes shown are the last good ones. */
        stale: boolean;
        /** Protection and cleanup await the machine's resources policy: the sizes are the last good ones, no cleanup is offered. */
        policyUnavailable: boolean;
        /** The person uses this machine without managing it: totals only (STO-29). */
        recipient: boolean;
    }>;

export function selectStorageTabView(input: Readonly<{
    status: MachineStorageState['status'];
    summary: StorageSummary | null;
    offline: boolean;
    recipient: boolean;
    failure?: MachineStorageState['failure'];
}>): StorageTabView {
    if (input.status === 'not_reported') return { kind: 'not_reported' };
    if (input.summary) {
        return { kind: 'ready', summary: input.summary, offline: input.offline, stale: input.status === 'error' && !input.offline,
            policyUnavailable: input.status === 'policy_unavailable', recipient: input.recipient };
    }
    if (input.offline) return { kind: 'offline_empty' };
    if (input.status === 'policy_unavailable') return { kind: 'policy_unavailable' };
    if (input.status === 'error') return { kind: 'error', ...(input.failure ? { failure: input.failure } : {}) };
    return { kind: 'loading' };
}

/** Human recovery stays separate from the daemon's secret-free diagnostic fields. */
export function describeStorageFailure(failure: Omit<MachineStorageFailure, 'ok'> | undefined) {
    const cause = failure?.failureCause;
    return {
        ...(failure?.reason === 'permission_denied' ? {
            reason: `${t('machineStorage.states.permissionDeniedReason')} ${t('machineStorage.states.permissionDeniedRemedy')}`,
        } : failure?.error ? { reason: failure.error } : {}),
        diagnosticCode: failure?.errorCode,
        diagnosticDetail: cause ? [cause.phase, cause.errorClass, cause.errorCode, cause.httpStatus].filter(value => value !== null).join(' · ') : undefined,
    };
}

// ── Totals and the sentence ──────────────────────────────────────────────────────────────────────────

/** Happier's bytes as the volumes counted them (one deduplicated union per disk). */
export function readHappierStorageBytes(summary: StorageSummary): number {
    if (summary.volumes.length > 0) return summary.volumes.reduce((sum, volume) => sum + volume.happierBytes, 0);
    return summary.categories.reduce((sum, category) => sum + category.size.allocatedBytes, 0);
}

export function readStorageCanGoBytes(summary: StorageSummary): number {
    return summary.categories.reduce((sum, category) => sum + category.canGoBytes, 0);
}

/** The disk the sentence speaks of: the one holding most of Happier, else the first. */
export function selectStorageHeadlineVolume(summary: StorageSummary): StorageVolume | null {
    let best: StorageVolume | null = null;
    for (const volume of summary.volumes) {
        if (!best || volume.happierBytes > best.happierBytes) best = volume;
    }
    return best;
}

export type StorageSentenceFacts = Readonly<{
    /** "412 GB free." of the headline disk; null without volumes. */
    freeBytes: number | null;
    happierBytes: number;
    /** The headline disk's name, or how many disks hold Happier when it is spread over several. */
    where: Readonly<{ kind: 'volume'; label: string }> | Readonly<{ kind: 'across'; count: number }> | Readonly<{ kind: 'none' }>;
    /** What can go; null when the reader is not shown the breakdown. */
    canGoBytes: number | null;
    /** What sits in Happier's Trash and comes back when it empties (lab RD); 0 for a reader not shown it. */
    trashBytes: number;
    trashEmptiesAt: number | null;
}>;

export function describeStorageSentence(summary: StorageSummary, options: Readonly<{ recipient: boolean; policyUnavailable?: boolean }>): StorageSentenceFacts {
    const managed = !options.recipient && options.policyUnavailable !== true;
    const headline = selectStorageHeadlineVolume(summary);
    const holding = summary.volumes.filter(volume => volume.happierBytes > 0).length;
    return {
        freeBytes: headline ? headline.freeBytes : null,
        happierBytes: readHappierStorageBytes(summary),
        where: !headline ? { kind: 'none' } : holding > 1 ? { kind: 'across', count: holding } : { kind: 'volume', label: storageVolumeName(headline) },
        canGoBytes: managed ? readStorageCanGoBytes(summary) : null,
        trashBytes: options.recipient ? 0 : summary.volumes.reduce((total, volume) => total + (volume.trashFreesBytes ?? 0), 0),
        trashEmptiesAt: options.recipient ? null : summary.trash.emptiesNextAt ?? null,
    };
}

/**
 * A disk's name: its own label; an unnamed root (Linux `/`, whose label is often just its mount path) reads as
 * the system disk, never a bare slash. Every surface naming a machine's disk (Storage, vitals, attention, alerts)
 * names it here; `sentence` is the form inside a sentence ("nl2’s system disk is nearly full").
 */
export function machineDiskName(
    disk: Readonly<{ label: string | null; mountPath?: string | null }>,
    form: 'title' | 'sentence' = 'title',
): string {
    const label = disk.label?.trim() ?? '';
    const mountPath = disk.mountPath ?? label;
    if (label && label !== mountPath) return label;
    if (mountPath === '/') return t(form === 'sentence' ? 'machineStorage.volumes.systemDiskInSentence' : 'machineStorage.volumes.systemDisk');
    return mountPath;
}

export function storageVolumeName(volume: StorageVolume, form: 'title' | 'sentence' = 'title'): string {
    return machineDiskName({ label: volume.volume.label, mountPath: volume.volume.mountPath }, form);
}

/** The mount path beside the name, when it says something the name does not ("/Volumes/Work"). */
/**
 * The boot and EFI partitions a Linux machine mounts: the system's, never where Happier or anything
 * the person clears lives. The disk section leaves them out unless Happier keeps something there.
 */
export function isStorageBootPartition(volume: StorageVolume): boolean {
    const path = volume.volume.mountPath;
    return volume.happierBytes === 0 && (path === '/boot' || path.startsWith('/boot/'));
}

export function storageVolumeMountHint(volume: StorageVolume): string | null {
    const path = volume.volume.mountPath;
    if (path === '/' || /^[A-Za-z]:[\\/]?$/u.test(path)) return null;
    return path === storageVolumeName(volume) ? null : path;
}

// ── A disk's bar (STO-1, the ghost of R24) ───────────────────────────────────────────────────────────

export type StorageVolumeParts = Readonly<{
    everythingElse: number;
    /** Happier's bytes not in the pile. */
    happier: number;
    /** Happier's bytes collected to clear: the hatched ghost. */
    pile: number;
    /** Happier's bytes already in its Trash on this disk: still taken, back when the Trash empties (lab RD). */
    trash: number;
    free: number;
    /** Space the system may reclaim; null when the capacity owner did not report it. Never free-now. */
    purgeable: number | null;
    /** Free space once the pile is cleared; null with an empty pile. */
    afterCleanupFree: number | null;
    /** Free space once the Trash empties; null with an empty Trash. */
    afterTrashFree: number | null;
}>;

/**
 * Everything else · Happier · in the pile · free, as parts of the disk's capacity. A volume's free
 * figure is the OS's; what is neither Happier's nor free is everything else (never negative).
 */
export function resolveStorageVolumeParts(volume: StorageVolume): StorageVolumeParts {
    const total = Math.max(0, volume.totalBytes);
    const free = Math.min(total, Math.max(0, volume.freeBytes));
    const happierAll = Math.min(Math.max(0, volume.happierBytes), total - free);
    const pile = Math.min(Math.max(0, volume.pileBytes), happierAll);
    const trash = Math.min(Math.max(0, volume.trashBytes), happierAll - pile);
    const everythingElse = Math.max(0, total - free - happierAll);
    const purgeable = volume.availableIncludingPurgeableBytes === undefined ? null
        : Math.min(everythingElse, Math.max(0, volume.availableIncludingPurgeableBytes - free));
    return {
        everythingElse: everythingElse - (purgeable ?? 0),
        happier: happierAll - pile - trash,
        pile,
        trash,
        free,
        purgeable,
        afterCleanupFree: pile > 0 && volume.pileFreesBytes !== undefined
            ? free + Math.min(pile, Math.max(0, volume.pileFreesBytes)) : null,
        afterTrashFree: trash > 0 && volume.trashFreesBytes !== undefined
            ? free + Math.min(trash, Math.max(0, volume.trashFreesBytes)) : null,
    };
}

// ── The breakdown (STO-2) and its ring (STO-5) ───────────────────────────────────────────────────────

/** Recordings appear only once there are some; every other kind is always listed (STO-2). */
export function orderStorageCategories(summary: StorageSummary): readonly StorageCategory[] {
    // Only kinds with content (lab `rs` H): one holding nothing yet, still being counted aside, is folded away.
    return summary.categories
        .filter(category => category.count > 0 || category.size.allocatedBytes > 0 || isStorageCategoryPartial(category)
            || (category.categoryId === 'trash' && summary.trash.count > 0))
        .slice()
        .sort((a, b) => b.size.allocatedBytes - a.size.allocatedBytes);
}

export type StorageCategoryTrailing =
    | Readonly<{ kind: 'can_go'; bytes: number }>
    | Readonly<{ kind: 'always_kept' }>
    | Readonly<{ kind: 'trash'; emptiesAt: number | null }>
    | Readonly<{ kind: 'none' }>;

/** Kinds Happier never offers to clear (agent sign-ins, its own state). */
const ALWAYS_KEPT: ReadonlySet<HappierStorageCategoryIdV1> = new Set(['agentHomes', 'ownData']);

/** The row's right-hand words: what can go, that it is always kept, or when the Trash empties. */
export function describeStorageCategoryTrailing(category: StorageCategory, summary: StorageSummary): StorageCategoryTrailing {
    if (category.categoryId === 'trash') {
        return category.count > 0 ? { kind: 'trash', emptiesAt: summary.trash.emptiesNextAt ?? null } : { kind: 'none' };
    }
    if (category.canGoBytes > 0) return { kind: 'can_go', bytes: category.canGoBytes };
    if (ALWAYS_KEPT.has(category.categoryId)) return { kind: 'always_kept' };
    return { kind: 'none' };
}

export function readStorageCategoryFact(category: StorageCategory, key: 'canGoCount' | 'keepCount'): number {
    const value = category.detailFacts[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A category whose owner could not tell everything it holds (its size is a floor). */
export function isStorageCategoryPartial(category: StorageCategory): boolean {
    return category.size.atLeast || category.detailFacts.factsReported === false;
}

/**
 * A size as every Storage surface says it: a lower bound keeps its "≥" on disk rows, Map tiles, Rings arcs,
 * category sizes and item rows alike. The one place that decides how an `atLeast` figure reads.
 */
export function formatStorageSize(bytes: number, atLeast: boolean): string {
    const size = formatMachineBytes(bytes, 'storage');
    return atLeast ? `≥ ${size}` : size;
}

export type StorageRingPart = Readonly<{
    id: string;
    /** A category, the rest folded together, or the pile. */
    kind: 'category' | 'rest' | 'pile';
    categoryId: HappierStorageCategoryIdV1 | null;
    bytes: number;
    /** Share of the ring (0..1). */
    fraction: number;
    /** Tone step: 0 darkest … 3 lightest; the pile is hatched instead. */
    tone: 0 | 1 | 2 | 3;
}>;

/** Named kinds before the rest fold together: a ring reads four greys apart, not ten. */
const RING_NAMED_PARTS = 3;

/**
 * Happier's bytes by kind as one ring (lab `rs` HR, HRV ★). The pile is the hatched arc closing the
 * ring; the kinds share what would be left after cleanup in proportion to their sizes, so the centre's
 * "after" figure and the solid arcs say the same thing. The legend keeps every exact size.
 */
export function buildStorageRing(summary: StorageSummary): Readonly<{
    parts: readonly StorageRingPart[];
    totalBytes: number;
    pileBytes: number;
    afterBytes: number;
}> {
    const categories = orderStorageCategories(summary).filter(category => category.size.allocatedBytes > 0);
    const totalBytes = readHappierStorageBytes(summary);
    const pileBytes = Math.min(totalBytes, Math.max(0, summary.pile.freesBytes));
    const afterBytes = totalBytes - pileBytes;
    const named = categories.slice(0, RING_NAMED_PARTS);
    const rest = categories.slice(RING_NAMED_PARTS).reduce((sum, category) => sum + category.size.allocatedBytes, 0);
    const kinds = [
        ...named.map((category, index) => ({ id: category.categoryId, kind: 'category' as const, categoryId: category.categoryId, bytes: category.size.allocatedBytes, tone: index as 0 | 1 | 2 })),
        ...(rest > 0 ? [{ id: 'rest', kind: 'rest' as const, categoryId: null, bytes: rest, tone: 3 as const }] : []),
    ];
    const kindsTotal = kinds.reduce((sum, part) => sum + part.bytes, 0);
    const solidShare = totalBytes > 0 ? afterBytes / totalBytes : 0;
    const parts: StorageRingPart[] = kinds.map(part => ({ ...part, fraction: kindsTotal > 0 ? (part.bytes / kindsTotal) * solidShare : 0 }));
    if (pileBytes > 0 && totalBytes > 0) {
        parts.push({ id: 'pile', kind: 'pile', categoryId: null, bytes: pileBytes, fraction: pileBytes / totalBytes, tone: 3 });
    }
    return { parts, totalBytes, pileBytes, afterBytes };
}
