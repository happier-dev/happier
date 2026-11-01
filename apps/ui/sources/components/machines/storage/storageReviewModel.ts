import type {
  PileApplyResultV1,
  PileItemRefV1,
  PileReviewV1,
  StorageItemCheckV1,
  StorageReasonV1,
  StorageVolumeRefV1,
} from '@happier-dev/protocol/storage/storageV1';

import { storagePathContains } from './storagePileModel';
import { storageVerdictStartsTicked } from '@/sync/domains/machines/storage/storageVerdictSelection';

/**
 * The review sheet (plan 40 STO-12/13, R24, lab `rs` R / Rp / PM 9–10): every item checked again on the
 * machine, what goes with what it frees and what is lost, what stays and why, and the one choice of where
 * it goes. The person may untick items here (the select-some narrowing, R41); whatever stays ticked is
 * exactly what the Action receives, each with the token the check returned.
 */

export type StorageReviewRow = Readonly<{
  itemId: string;
  path: string;
  title: string;
  check: StorageItemCheckV1;
  verdict: StorageItemCheckV1['verdict'];
  reason: StorageReasonV1;
  /** What a confirmation names for a Keep item ("3 files with changes"). */
  loses: readonly StorageReasonV1[];
  /** What the item takes on its disk (the page's "in the pile"); `freesBytes` is what comes back. */
  allocatedBytes: number;
  freesBytes: number;
  volumeId: string | null;
  /** The item's disk keeps a Happier Trash; without one only Delete now can take it. */
  trashAvailable: boolean;
}>;

export type StorageReview = Readonly<{
  going: readonly StorageReviewRow[];
  staying: readonly Readonly<{
    itemId: string;
    path: string;
    title: string;
    reason: StorageReasonV1;
  }>[];
  /** Bytes shared between items of the pile, counted once ("3 node_modules are inside worktrees here"). */
  countedOnceBytes: number;
  absorbedCount: number;
  totalFreesBytes: number;
}>;

export type StorageReviewMode = 'trash' | 'delete';

export type StorageReviewApplyItem = Readonly<{
  ref: PileItemRefV1;
  expect: string;
  claimedVerdict?: StorageItemCheckV1['verdict'];
  reason?: StorageReasonV1;
}>;

export type StorageReviewApply = Readonly<{
  items: readonly StorageReviewApplyItem[];
  /** Ticked items a Trash move cannot take (their disk has no Happier Trash). */
  withoutTrash: readonly string[];
  count: number;
  /** What the acted-on items take (the pile legend's quantity), as the page's pile reads it. */
  allocatedBytes: number;
  /** What they free (the total, the dock's quantity). */
  freesBytes: number;
  /**
   * The sessions holding an in-use item the person still has ticked (each `in_use` reason names its
   * holder), once each: "Stop the session and remove" stops these before anything moves (R42.1).
   */
  holders: readonly string[];
}>;

function holdingSessions(rows: readonly StorageReviewRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const reason of [row.reason, ...row.loses]) {
      const sessionId = reason.code === 'in_use' ? reason.detail?.sessionId : undefined;
      if (typeof sessionId === 'string' && sessionId.length > 0) ids.add(sessionId);
    }
  }
  return [...ids];
}

function volumeOf(
  path: string,
  volumes: readonly Readonly<{ volume: StorageVolumeRefV1 }>[],
): string | null {
  let best: StorageVolumeRefV1 | null = null;
  for (const { volume } of volumes) {
    const mount = volume.mountPath;
    const holds =
      mount === '/' || path === mount || storagePathContains(mount, path);
    if (holds && (!best || mount.length > best.mountPath.length)) best = volume;
  }
  return best?.volumeId ?? null;
}

export function buildStorageReview(
  review: PileReviewV1,
  volumes: readonly Readonly<{ volume: StorageVolumeRefV1 }>[],
): StorageReview {
  // Titleless persisted/wire reviews predate the daemon's catalog-title projection.
  const legacyTitle = (path: string) => path.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || path;
  const trash = new Map(
    review.trashVolumes.map((entry) => [entry.volumeId, entry.trashAvailable]),
  );
  const going = review.items
    .filter((check) => check.verdict !== 'forbidden')
    .map((check): StorageReviewRow => {
      const volumeId = volumeOf(check.ref.path, volumes);
      return {
        itemId: check.ref.itemId,
        path: check.ref.path,
        title: check.title ?? check.ref.title ?? legacyTitle(check.ref.path),
        check,
        verdict: check.verdict,
        reason: check.reason,
        loses: check.loses ?? [],
        allocatedBytes: check.size.allocatedBytes,
        freesBytes: check.size.freesBytes,
        volumeId,
        // A disk the review does not name keeps its Trash (the daemon names every disk without one).
        trashAvailable:
          volumeId === null ? true : (trash.get(volumeId) ?? true),
      };
    })
    .sort((a, b) => b.freesBytes - a.freesBytes);
  return {
    going,
    staying: [...review.staying, ...review.items.filter((check) => check.verdict === 'forbidden')
      .map((check) => ({ item: { ...check.ref, title: check.title ?? check.ref.title }, reason: check.reason }))].map((entry) => ({
      itemId: entry.item.itemId,
      path: entry.item.path,
      title: entry.item.title ?? legacyTitle(entry.item.path),
      reason: entry.reason,
    })),
    countedOnceBytes: review.countedOnceBytes,
    absorbedCount: review.items.reduce(
      (sum, check) => sum + check.absorbs.length,
      0,
    ),
    totalFreesBytes: review.totalFreesBytes,
  };
}

/** Unchanged verdicts retain the person's choice; new/changed verdicts take the shared default. */
export function selectStorageReviewTicks(
  review: StorageReview,
  previous?: Readonly<{ review: StorageReview; selected: ReadonlySet<string> }>,
): ReadonlySet<string> {
  const before = new Map(previous?.review.going.map((row) => [row.itemId, row.verdict]));
  return new Set(review.going.filter((row) =>
    previous && before.get(row.itemId) === row.verdict
      ? previous.selected.has(row.itemId)
      : storageVerdictStartsTicked(row.verdict),
  ).map((row) => row.itemId));
}

export function selectStorageReviewApply(
  review: StorageReview,
  selected: ReadonlySet<string>,
  mode: StorageReviewMode,
): StorageReviewApply {
  const ticked = review.going.filter((row) => selected.has(row.itemId));
  const acting =
    mode === 'trash' ? ticked.filter((row) => row.trashAvailable) : ticked;
  const items = acting.map((row): StorageReviewApplyItem =>
    mode === 'trash'
      ? {
          ref: row.check.ref,
          expect: row.check.expect,
          claimedVerdict: row.verdict,
          reason: row.reason,
        }
      : { ref: row.check.ref, expect: row.check.expect },
  );
  const frees = acting.reduce((sum, row) => sum + row.freesBytes, 0);
  return {
    items,
    withoutTrash:
      mode === 'trash'
        ? ticked.filter((row) => !row.trashAvailable).map((row) => row.itemId)
        : [],
    count: items.length,
    allocatedBytes: acting.reduce((sum, row) => sum + row.allocatedBytes, 0),
    // Per-root exclusivity omits a hardlink whose other name is in another
    // selected root. The daemon measured that full union, so reuse it when
    // the selection still contains every reviewed root.
    freesBytes: acting.length === review.going.length ? review.totalFreesBytes : Math.min(frees, review.totalFreesBytes),
    holders: holdingSessions(acting),
  };
}

/** What happened, per item: the count shown is the set acted on (STO-13). */
export function describeStorageApplyResult(
  result: PileApplyResultV1,
): Readonly<{
  acted: number;
  skipped: number;
  refused: number;
  failed: number;
  notActed: PileApplyResultV1['outcomes'];
}> {
  let acted = 0;
  let skipped = 0;
  let refused = 0;
  let failed = 0;
  for (const outcome of result.outcomes) {
    if (outcome.status === 'moved' || outcome.status === 'deleted') acted++;
    else if (outcome.status === 'skipped') skipped++;
    else if (outcome.status === 'refused') refused++;
    else failed++;
  }
  return {
    acted,
    skipped,
    refused,
    failed,
    notActed: result.outcomes.filter(
      (outcome) => outcome.status !== 'moved' && outcome.status !== 'deleted',
    ),
  };
}
