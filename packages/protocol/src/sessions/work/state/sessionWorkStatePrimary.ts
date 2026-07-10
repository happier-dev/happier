import type { SessionWorkStateWriteItemV1 } from './sessionWorkStateV1.js';

/**
 * Canonical primary-item resolution for the unified session work-state (MED-2).
 *
 * `metadata.sessionWorkStateV1` is written by MULTIPLE independent sources (the
 * Claude/Codex goal source, the task/todo trackers, the inactive goal effector).
 * If each source forced its own `primaryItemId`, the work-state BADGE would flip
 * between goal and task/todo purely by publish order ("last-source-to-publish
 * wins"). Instead there is ONE rule, applied over the MERGED item set at the
 * merge chokepoint, so the primary is deterministic and source-order-independent.
 *
 * The priority mirrors the UI's `resolvePrimarySessionWorkStateItem`
 * (active task > active todo > active goal > blocked > paused > pending > first)
 * so the CLI write and the UI read agree on what "primary" means.
 *
 * Stability: when the previously-resolved primary is still present, is a
 * task/todo, AND is still tied for the WINNING priority rank, it is preserved so
 * the badge does not jitter between equal-priority task/todo rows as they update.
 * Stability is a same-priority tie-break ONLY — a previously-primary task/todo
 * that has dropped in rank (e.g. it COMPLETED or was CANCELLED) must NOT pin the
 * badge over a higher-priority active goal/task/todo, and a previously-primary
 * GOAL is likewise never preserved over a higher-priority active task/todo. This
 * is the whole point of the deterministic rule (G4 fix: the prior stability
 * branch trusted a present task/todo without a rank check, so a completed task
 * could keep pinning the badge over an active goal).
 */

type WorkStateItemRecord = Record<string, unknown>;

function asRecord(value: unknown): WorkStateItemRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as WorkStateItemRecord : null;
}

function readId(item: WorkStateItemRecord): string | null {
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  return id.length > 0 ? id : null;
}

function isKind(item: WorkStateItemRecord, kind: 'goal' | 'task' | 'todo'): boolean {
  return item.kind === kind;
}

function isTaskOrTodo(item: WorkStateItemRecord): boolean {
  return isKind(item, 'task') || isKind(item, 'todo');
}

function isStatus(item: WorkStateItemRecord, status: string): boolean {
  return item.status === status;
}

function toIdSet(ids: readonly string[] | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  for (const id of ids ?? []) {
    const normalized = typeof id === 'string' ? id.trim() : '';
    if (normalized) set.add(normalized);
  }
  return set;
}

/**
 * The canonical primary-priority ladder, ordered best-first. Used BOTH to compute the winning rank
 * for the stability tie-break and to select the final primary, so there is a single source of truth
 * for "what is primary" (no similar-but-different predicate sets). Items matching no rung fall into
 * the terminal/unknown bucket (`complete`/`cancelled`/`unknown`) and rank below every active rung,
 * so they only become primary when nothing else can.
 */
const PRIMARY_PRIORITY_LADDER: ReadonlyArray<(item: WorkStateItemRecord) => boolean> = [
  (item) => isKind(item, 'task') && isStatus(item, 'active'),
  (item) => isKind(item, 'todo') && isStatus(item, 'active'),
  (item) => isKind(item, 'goal') && isStatus(item, 'active'),
  (item) => isStatus(item, 'blocked'),
  (item) => isStatus(item, 'paused'),
  (item) => isStatus(item, 'pending'),
];

/** Lower is higher priority. The terminal/unknown bucket sits just past the last rung. */
function primaryRank(item: WorkStateItemRecord): number {
  for (let index = 0; index < PRIMARY_PRIORITY_LADDER.length; index += 1) {
    if (PRIMARY_PRIORITY_LADDER[index]!(item)) return index;
  }
  return PRIMARY_PRIORITY_LADDER.length;
}

export type ResolveSessionWorkStatePrimaryOptions = Readonly<{
  /**
   * The previously-resolved primary. Preserved when it is still a present
   * task/todo so the badge does not jitter between equal-priority work items.
   */
  currentPrimaryItemId?: string | null;
  /**
   * Item ids written by the CURRENT publish (the merge passes `nextOwned`'s ids).
   * Within a single priority bucket the most-recently-published item wins the tie,
   * so e.g. the goal you JUST set becomes primary over a stale pre-existing goal
   * of the same status. This is one general recency rule — it never lets a lower
   * priority beat a higher one (an active task still outranks a just-set goal).
   */
  preferItemIds?: readonly string[];
}>;

/**
 * Resolve the canonical `primaryItemId` for a (merged) set of work-state items.
 */
export function resolveSessionWorkStatePrimaryItemId(
  items: readonly SessionWorkStateWriteItemV1[],
  currentPrimaryItemId?: string | null,
  options?: ResolveSessionWorkStatePrimaryOptions,
): string | null {
  const records = items.flatMap((item): WorkStateItemRecord[] => {
    const record = asRecord(item);
    return record && readId(record) ? [record] : [];
  });
  if (records.length === 0) return null;

  const current = (typeof currentPrimaryItemId === 'string' ? currentPrimaryItemId.trim() : '') || null;
  const preferredIds = toIdSet(options?.preferItemIds);

  // The best (lowest) rank present. The stability tie-break preserves the current primary only when
  // it is STILL tied for this rank, so a row that dropped in rank (e.g. completed/cancelled) yields.
  const winningRank = records.reduce((best, item) => Math.min(best, primaryRank(item)), PRIMARY_PRIORITY_LADDER.length);

  // Stability: keep the current primary only when it is still a present task/todo AND still tied for
  // the winning rank (a same-priority tie-break — never a pre-priority pin).
  if (current) {
    const currentRecord = records.find((item) => readId(item) === current);
    if (currentRecord && isTaskOrTodo(currentRecord) && primaryRank(currentRecord) === winningRank) {
      return current;
    }
  }

  // Within a priority bucket, prefer a just-published item over a stale one
  // (recency tie-break), otherwise fall back to document order.
  const pick = (predicate: (item: WorkStateItemRecord) => boolean): string | null => {
    const matches = records.filter(predicate);
    if (matches.length === 0) return null;
    const preferred = matches.find((item) => {
      const id = readId(item);
      return id ? preferredIds.has(id) : false;
    });
    return readId(preferred ?? matches[0] ?? {}) ?? null;
  };

  for (const predicate of PRIMARY_PRIORITY_LADDER) {
    const picked = pick(predicate);
    if (picked) return picked;
  }
  return readId(records[0] ?? {}) ?? null;
}
