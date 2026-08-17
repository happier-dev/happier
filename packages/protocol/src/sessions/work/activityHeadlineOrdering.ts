/**
 * The one owner of how a session-activity headline is ordered and bounded.
 *
 * A "headline" is the compact live pointer a session publishes into its metadata. There are two of
 * them — `sessionWorkflowActivityHeadlineV1` and `sessionAgentActivityHeadlineV1` — and the second
 * is DERIVED from the same committed snapshots as the first, not parallel to it. Both call the
 * functions below, so a second comparator or a second cap cannot appear without deleting one of
 * these.
 *
 * Three semantics live here, and each exists because getting it wrong is a user-visible defect:
 *
 * 1. **Active entries are never capped.** How much work is running concurrently is provider
 *    behaviour, not a Happier limit. Capping it would make a roster silently incomplete.
 * 2. **Only terminal history is bounded**, newest first, with the omitted count reported so a
 *    consumer knows the history is partial instead of inferring that nothing else ever happened.
 * 3. **Progress timestamps take no part in active ordering.** Active work updates constantly; an
 *    `updatedAt`-ordered active list reshuffles the badge and the popover on every progress tick,
 *    under the eyes of someone reading it. Ordering is priority first, identity as the tie-break,
 *    which makes it a *total* order — every client derives the same sequence and therefore the same
 *    primary entry.
 *
 * Deliberately generic and dependency-free: the domain supplies terminality, priority and the
 * projection, because those are vocabulary decisions. This module owns only the mechanism, and
 * knows nothing about workflows, agents, or which key a headline is published under.
 */

/** How the mechanism reads the three facts it needs out of a domain's headline entry. */
export type ActivityHeadlineEntryAccessors<TEntry> = Readonly<{
  /**
   * Stable identity. Used as the final tie-break on both sides of the partition so the ordering is
   * total rather than dependent on input order or the engine's sort stability.
   */
  id: (entry: TEntry) => string;
  /**
   * Rank among ACTIVE entries; lower sorts first. A domain puts whatever escalates in front —
   * blocked-on-a-person before live before merely admitted.
   */
  activePriority: (entry: TEntry) => number;
  /**
   * Last-evidence instant. Orders TERMINAL history only; see semantic 3 above for why the active
   * side must not consult it.
   */
  updatedAt: (entry: TEntry) => number;
}>;

export type BoundedActivityHeadlineHistory<TEntry> = Readonly<{
  /** Newest-first, at most `limit` long. */
  recent: TEntry[];
  /** How many terminal entries the bound dropped. Zero when the history fit. */
  omittedCount: number;
}>;

export type PartitionedActivityHeadlineEntries<TEntry> = BoundedActivityHeadlineHistory<TEntry> & Readonly<{
  /** Every non-terminal entry, ordered by escalation. Never bounded. */
  active: TEntry[];
}>;

export type PartitionActivityHeadlineEntriesInput<TEntry> = Readonly<{
  entries: readonly TEntry[];
  accessors: ActivityHeadlineEntryAccessors<TEntry>;
  isTerminal: (entry: TEntry) => boolean;
  /**
   * Narrows an entry to the fields a headline may carry. Applied at this one chokepoint, before
   * partitioning, so no path through a builder can leak detail into session metadata.
   */
  project: (entry: TEntry) => TEntry;
  recentLimit: number;
}>;

function compareById<TEntry>(
  accessors: Pick<ActivityHeadlineEntryAccessors<TEntry>, 'id'>,
  left: TEntry,
  right: TEntry,
): number {
  const leftId = accessors.id(left);
  const rightId = accessors.id(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** Deterministic active ordering: ascending priority, then ascending id. Pure; never mutates. */
export function sortActiveActivityHeadlineEntries<TEntry>(
  entries: readonly TEntry[],
  accessors: Pick<ActivityHeadlineEntryAccessors<TEntry>, 'id' | 'activePriority'>,
): TEntry[] {
  return [...entries].sort((left, right) => (
    accessors.activePriority(left) - accessors.activePriority(right)
    || compareById(accessors, left, right)
  ));
}

/** Bound terminal history only: newest first, then ascending id, sliced to `limit`. */
export function boundRecentActivityHeadlineEntries<TEntry>(
  entries: readonly TEntry[],
  accessors: Pick<ActivityHeadlineEntryAccessors<TEntry>, 'id' | 'updatedAt'>,
  limit: number,
): BoundedActivityHeadlineHistory<TEntry> {
  const sorted = [...entries].sort((left, right) => (
    accessors.updatedAt(right) - accessors.updatedAt(left)
    || compareById(accessors, left, right)
  ));
  const recent = sorted.slice(0, Math.max(0, limit));
  return { recent, omittedCount: sorted.length - recent.length };
}

/**
 * Project, split active from terminal, order each side by its own rule, and bound the terminal side.
 * The single entry point both headline builders use.
 */
export function partitionActivityHeadlineEntries<TEntry>(
  input: PartitionActivityHeadlineEntriesInput<TEntry>,
): PartitionedActivityHeadlineEntries<TEntry> {
  const active: TEntry[] = [];
  const terminal: TEntry[] = [];
  for (const rawEntry of input.entries) {
    const entry = input.project(rawEntry);
    if (input.isTerminal(entry)) {
      terminal.push(entry);
    } else {
      active.push(entry);
    }
  }
  const bounded = boundRecentActivityHeadlineEntries(terminal, input.accessors, input.recentLimit);
  return {
    active: sortActiveActivityHeadlineEntries(active, input.accessors),
    recent: bounded.recent,
    omittedCount: bounded.omittedCount,
  };
}
