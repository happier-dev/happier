import { z } from '../../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SessionWorkStateItemV1Schema, type SessionWorkStateWriteItemV1 } from './sessionWorkStateV1.js';

export const SessionWorkDisplayItemV1Schema = lazyZodSchema(() => z.strictObject(z.pick(SessionWorkStateItemV1Schema, {
  id: true, kind: true, title: true, status: true, statusReason: true,
}).shape));
export type SessionWorkDisplayItemV1 = z.infer<typeof SessionWorkDisplayItemV1Schema>;

export const SessionTaskProgressV1Schema = lazyZodSchema(() => z.strictObject({
  done: z.number().check(z.int(), z.nonnegative()),
  total: z.number().check(z.int(), z.positive()),
}));
export type SessionTaskProgressV1 = z.infer<typeof SessionTaskProgressV1Schema>;

export function isSessionTaskItemV1(item: Pick<SessionWorkDisplayItemV1, 'kind'>): boolean {
  return item.kind === 'task' || item.kind === 'todo';
}

export function projectSessionTaskProgressV1(
  items: readonly Pick<SessionWorkDisplayItemV1, 'kind' | 'status'>[],
): SessionTaskProgressV1 | undefined {
  let total = 0;
  let done = 0;
  for (const item of items) {
    if (!isSessionTaskItemV1(item)) continue;
    total++;
    if (item.status === 'complete') done++;
  }
  return total > 0 ? { done, total } : undefined;
}

/** Display facts only; neither retained work history nor a full work-state snapshot. */
export const SessionWorkDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  primaryItem: z.nullable(SessionWorkDisplayItemV1Schema),
  hasActiveGoal: z.boolean(),
  taskProgress: z.optional(SessionTaskProgressV1Schema),
}));
export type SessionWorkDisplayV1 = z.infer<typeof SessionWorkDisplayV1Schema>;

type SessionWorkDisplaySourceV1 = Readonly<{
  items: readonly SessionWorkDisplayItemV1[];
  primaryItemId?: string | null;
}>;

/** Full readers and compact readers share the canonical primary-item decision. */
export function projectSessionWorkDisplayV1(
  work: SessionWorkDisplaySourceV1 | SessionWorkDisplayV1 | null | undefined,
): SessionWorkDisplayV1 | null {
  if (!work) return null;
  if (!('items' in work)) return work;
  const primary = readSessionWorkStatePrimaryItemV1(work.items, work.primaryItemId);
  const taskProgress = projectSessionTaskProgressV1(work.items);
  return {
    v: 1,
    primaryItem: primary ? {
      id: primary.id,
      kind: primary.kind,
      title: primary.title,
      status: primary.status,
      ...(primary.statusReason === undefined ? {} : { statusReason: primary.statusReason }),
    } : null,
    hasActiveGoal: work.items.some(item => item.kind === 'goal' && item.status === 'active'),
    ...(taskProgress ? { taskProgress } : {}),
  };
}

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
  items: readonly SessionWorkStateWriteItemV1[] | readonly unknown[],
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

/**
 * Read the primary work ITEM rather than its id, for the readers that need the object.
 *
 * A stored `primaryItemId` is honoured whenever it still names a present item: the publish-time
 * merge already applied the canonical rule above, so a reader that recomputed it would be a
 * second decision-maker that disagrees with the badge the writer chose. The ladder is consulted
 * only when there is no usable stored identity — which is exactly why readers must not carry
 * their own fallback ordering (that copy is how `paused` and terminal work went missing).
 */
export function readSessionWorkStatePrimaryItemV1<TItem>(
  items: readonly TItem[],
  primaryItemId?: string | null,
): TItem | null {
  if (items.length === 0) return null;
  const readItemId = (item: TItem): string | null => {
    const record = asRecord(item);
    return record ? readId(record) : null;
  };

  const stored = (typeof primaryItemId === 'string' ? primaryItemId.trim() : '') || null;
  if (stored) {
    const storedItem = items.find((item) => readItemId(item) === stored);
    if (storedItem !== undefined) return storedItem;
  }

  const resolvedId = resolveSessionWorkStatePrimaryItemId(items);
  if (!resolvedId) return null;
  return items.find((item) => readItemId(item) === resolvedId) ?? null;
}
