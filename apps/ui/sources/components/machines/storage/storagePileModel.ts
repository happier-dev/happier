import type {
  PileApplyResultV1,
  PileSummaryV1,
  StorageItemRefV1,
  StorageItemV1,
} from '@happier-dev/protocol/storage/storageV1';
import { toStorageItemRef } from '@/sync/domains/machines/storage/pileRef';
import { storageVerdictStartsTicked } from '@/sync/domains/machines/storage/storageVerdictSelection';
import { resolveHappierListMultiSelectionRange } from '@happier-dev/plugin-ui/presentation';
import { storageTrashReceiptBytes, type StorageTrashReceipt } from '@/sync/domains/machines/storage/trashReceipt';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { t } from '@/text';

import { storageReasonLabel } from './storageReasonPresentation';

/**
 * Collecting (plan 40 STO-11, ruling 4, lab `rs` PM): ticking a row is putting it in the machine's one
 * pile. The pile on the machine is the only authority; a row's tick is only how the pile reads for that
 * row, and every tick is one `machines.storage.pile.set` delta. Nothing here stores a selection.
 */

/**
 * How a row's box reads: in the pile; covered because a folder holding it is in the pile; free to tick;
 * a Keep item whose box first asks the person to confirm what is lost (R42.1); or no box at all
 * (Forbidden, or not collectable by the owner's verdict).
 */
export type StorageCollectState =
  | 'collected'
  | 'inside'
  | 'available'
  | 'confirm'
  | 'none';
export type StorageCollectable = Pick<
  StorageItemV1,
  'itemId' | 'path' | 'verdict' | 'collectable'
>;
/** One `pile.set` delta (its arrays are the Action input's): served references in, item ids out. */
export type StoragePileDelta = Readonly<{ add?: StorageItemRefV1[]; remove?: string[] }>;
/**
 * The pile's membership as a row reads it: the machine's own refs plus any delta still on its way,
 * which carry only the served reference until the machine answers.
 */
export type StoragePileMembership = readonly Readonly<StorageItemRefV1>[];

/** What the pile bar says after the review sheet acted, held for the machine until dismissed. */
export type StoragePileReceipt =
  | Readonly<{
      kind: 'applied';
      result: PileApplyResultV1;
      emptiesAt: number | null;
      trash?: StorageTrashReceipt;
    }>
  | Readonly<{ kind: 'emptied'; count: number; freedBytes: number; restoredCount?: number }>;

export type StoragePileBar =
  | Readonly<{ kind: 'hidden' }>
  | Readonly<{ kind: 'ready'; count: number; freesBytes: number }>
  | Readonly<{ kind: 'checking'; count: number; freesBytes: number }>
  /** Moved to Happier's Trash: the space is not back yet (R25). */
  | Readonly<{
      kind: 'held';
      batchId: string;
      count: number;
      /** Null when the remaining entries do not prove a physical allocation union. */
      inTrashBytes: number | null;
      notActed: number;
      emptiesAt: number | null;
      /** Remaining entry identities, typed reasons, and actual settled counts/bytes from the receipt owner. */
      trash?: StorageTrashReceipt;
    }>
  /** True at once: deleted now, or the Trash was emptied. */
  | Readonly<{ kind: 'freed'; count: number; freedBytes: number; restoredCount?: number }>
  /** A newer scan took the pile's last items away: the bar stays to say so until Done (STO-11). */
  | Readonly<{ kind: 'dropped'; count: number }>;

function trimEnd(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
}

/** `child` sits inside `parent` (either separator; a sibling sharing a prefix is not inside). */
export function storagePathContains(parent: string, child: string): boolean {
  const a = trimEnd(parent);
  const b = trimEnd(child);
  if (b.length <= a.length || !b.startsWith(a)) return false;
  const next = b.charAt(a.length);
  return next === '/' || next === '\\' || a.endsWith('/') || a.endsWith('\\');
}

type PileIndex = Readonly<{
  /** The first entry (in pile order) for an item id, and for a trimmed path. */
  byId: ReadonlyMap<string, number>;
  byPath: ReadonlyMap<string, number>;
  /** Every entry's trimmed path, for "a folder holding it is in the pile". */
  paths: ReadonlySet<string>;
}>;

/**
 * What a row asks of the pile (its entry, or whether a folder holding it is in) is answered from one index of the
 * pile's membership, built once per pile and shared by every row that reads it. A page of thousands of rows asks
 * this for each, so scanning the pile per row would cost rows × pile on every change of the pile.
 */
const pileIndexes = new WeakMap<StoragePileMembership, PileIndex>();

function indexOfPile(pile: StoragePileMembership): PileIndex {
  const known = pileIndexes.get(pile);
  if (known) return known;
  const byId = new Map<string, number>();
  const byPath = new Map<string, number>();
  const paths = new Set<string>();
  pile.forEach((entry, position) => {
    const path = trimEnd(entry.path);
    if (!byId.has(entry.itemId)) byId.set(entry.itemId, position);
    if (!byPath.has(path)) byPath.set(path, position);
    paths.add(path);
  });
  const index = { byId, byPath, paths };
  pileIndexes.set(pile, index);
  return index;
}

function pileEntryFor(
  item: StorageCollectable,
  pile: StoragePileMembership,
): Readonly<StorageItemRefV1> | null {
  const index = indexOfPile(pile);
  const byId = index.byId.get(item.itemId);
  const byPath = index.byPath.get(trimEnd(item.path));
  const position = byId === undefined ? byPath : byPath === undefined ? byId : Math.min(byId, byPath);
  return position === undefined ? null : pile[position]!;
}

/** A folder holding `path` (either separator) is in the pile; the walk is the path's depth, not the pile's size. */
function pileHoldsFolderOf(path: string, pile: StoragePileMembership): boolean {
  const { paths } = indexOfPile(pile);
  if (paths.size === 0) return false;
  const trimmed = trimEnd(path);
  for (let at = 0; at < trimmed.length; at += 1) {
    const code = trimmed.charCodeAt(at);
    if (code !== 47 && code !== 92) continue;
    if (at === 0 ? paths.has('') || paths.has(trimmed.charAt(0)) : paths.has(trimmed.slice(0, at))) return true;
  }
  return false;
}

export function describeStorageCollect(
  item: StorageCollectable,
  pile: StoragePileMembership,
): StorageCollectState {
  if (item.verdict === 'forbidden') return 'none';
  if (pileEntryFor(item, pile)) return 'collected';
  if (pileHoldsFolderOf(item.path, pile)) return 'inside';
  // The owner decides once whether a row can be collected; the box never re-decides it from the verdict.
  if (!item.collectable) return 'none';
  return item.verdict === 'keep' ? 'confirm' : 'available';
}


export function resolveStorageCollectToggle(
  item: StorageCollectable,
  pile: StoragePileMembership,
): StoragePileDelta | null {
  const state = describeStorageCollect(item, pile);
  if (state === 'collected') return { remove: [pileEntryFor(item, pile)!.itemId] };
  return state === 'available' || state === 'confirm'
    ? { add: [toStorageItemRef(item)] }
    : null;
}

/** Group and range sweeps take the verdict default; Caution and Keep require an explicit row choice. */
function sweepable(
  item: StorageCollectable,
  pile: StoragePileMembership,
): boolean {
  if (!storageVerdictStartsTicked(item.verdict)) return false;
  const state = describeStorageCollect(item, pile);
  return state === 'collected' || state === 'available';
}

export function describeStorageGroupCollect(
  items: readonly StorageCollectable[],
  pile: StoragePileMembership,
): 'checked' | 'mixed' | 'unchecked' | null {
  const candidates = items.filter((item) => sweepable(item, pile));
  if (candidates.length === 0) return null;
  const collected = candidates.filter((item) =>
    pileEntryFor(item, pile),
  ).length;
  return collected === 0
    ? 'unchecked'
    : collected === candidates.length
      ? 'checked'
      : 'mixed';
}

/** "Collect all N that can go": adds the rest; when all of them are in, the same press takes them out. */
export function resolveStorageCollectAll(
  items: readonly StorageCollectable[],
  pile: StoragePileMembership,
): StoragePileDelta | null {
  const state = describeStorageGroupCollect(items, pile);
  if (state === null) return null;
  const candidates = items.filter((item) => sweepable(item, pile));
  if (state === 'checked')
    return {
      remove: candidates.map((item) => pileEntryFor(item, pile)!.itemId),
    };
  const add = candidates
    .filter((item) => !pileEntryFor(item, pile))
    .map(toStorageItemRef);
  return add.length ? { add } : null;
}

export function describeStoragePileBar(
  input: Readonly<{
    pile: PileSummaryV1 | null;
    receipt: StoragePileReceipt | null;
    checking: Readonly<{ count: number; freesBytes: number }> | null;
  }>,
): StoragePileBar {
  if (input.checking) return { kind: 'checking', ...input.checking };
  const { receipt } = input;
  if (receipt?.kind === 'emptied')
    return {
      kind: 'freed',
      count: receipt.count,
      freedBytes: receipt.freedBytes,
      ...(receipt.restoredCount ? { restoredCount: receipt.restoredCount } : {}),
    };
  if (receipt?.kind === 'applied') {
    const { result } = receipt;
    const acted = result.outcomes.filter(
      (outcome) => outcome.status === 'moved' || outcome.status === 'deleted',
    ).length;
    if (result.mode === 'delete')
      return { kind: 'freed', count: acted, freedBytes: result.freedBytes };
    return {
      kind: 'held',
      batchId: result.batchId,
      count: receipt.trash ? receipt.trash.remaining.length + receipt.trash.unknownCount : acted,
      inTrashBytes: receipt.trash ? storageTrashReceiptBytes(result, receipt.trash) : result.inTrashBytes,
      notActed: result.outcomes.length - acted,
      emptiesAt: receipt.emptiesAt,
      ...(receipt.trash ? { trash: receipt.trash } : {}),
    };
  }
  if (!input.pile) return { kind: 'hidden' };
  if (input.pile.count === 0) {
    const dropped = input.pile.droppedSinceLastView.length;
    return dropped > 0 ? { kind: 'dropped', count: dropped } : { kind: 'hidden' };
  }
  return {
    kind: 'ready',
    count: input.pile.count,
    freesBytes: input.pile.freesBytes,
  };
}

/**
 * What a held pile says once an Empty settled only part of it (lab `rs` RD: partial results are said plainly):
 * how many stayed in the Trash and the machine's typed reason, then what did go. `null` while no Empty
 * outcome concerns the entries still held, so the caller's own note stands.
 */
export function describeStoragePileReceiptNote(bar: StoragePileBar): string | null {
  if (bar.kind !== 'held' || !bar.trash?.emptyOutcomes) return null;
  const { trash } = bar;
  const outcomes = trash.emptyOutcomes!;
  const stayed = trash.remaining.flatMap((entry) => {
    const outcome = outcomes[entry.entryId];
    return outcome && outcome.status !== 'deleted' ? [outcome] : [];
  });
  if (stayed.length === 0) return null;
  const reasons = [...new Set(stayed.map((outcome) => storageReasonLabel(outcome.reason ?? { code: 'operation_failed' })))];
  const refused = t('machineStorage.pile.emptyRefused', { count: stayed.length, reason: reasons.join(', ') });
  const emptied = Object.values(outcomes).filter((outcome) => outcome.status === 'deleted').length;
  if (emptied === 0) return refused;
  const went = trash.freedBytesKnown === false || trash.freedBytes <= 0
    ? t('machineStorage.pile.emptiedOnly', { count: emptied })
    : t('machineStorage.pile.emptiedFreed', { count: emptied, amount: formatMachineBytes(trash.freedBytes, 'storage') });
  return `${refused} ${went}`;
}

/**
 * Shift-collect (lab PM, plan 40 §7(g)): the rows between the last tick and this one, through the
 * Collection's own range resolver, counting only rows selected by the shared Safe default.
 * A collected target takes the range out; otherwise the range goes in. One `pile.set` delta.
 */
export function resolveStorageCollectRange(input: Readonly<{ rows: readonly StorageCollectable[]; pile: StoragePileMembership;
  anchorKey: string | null; targetKey: string }>): StoragePileDelta | null {
  const eligible = new Set(input.rows.filter((row) => sweepable(row, input.pile)).map((row) => row.itemId));
  const keys = new Set(resolveHappierListMultiSelectionRange({ visibleOrderedKeys: input.rows.map((row) => row.itemId),
    anchorKey: input.anchorKey, targetKey: input.targetKey, eligibleKeys: eligible }));
  if (keys.size === 0) return null;
  const inRange = input.rows.filter((row) => keys.has(row.itemId));
  const target = inRange.find((row) => row.itemId === input.targetKey)!;
  if (pileEntryFor(target, input.pile)) {
    return { remove: inRange.map((row) => pileEntryFor(row, input.pile)?.itemId).filter((id): id is string => !!id) };
  }
  const add = inRange.filter((row) => describeStorageCollect(row, input.pile) === 'available').map(toStorageItemRef);
  return add.length ? { add } : null;
}
