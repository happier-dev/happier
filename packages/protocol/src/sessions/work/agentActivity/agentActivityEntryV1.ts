import { z } from 'zod';

import { AgentActivityKindV1Schema } from './agentActivityKindV1.js';
import { AgentActivityStatusV1Schema, type AgentActivityStatusV1 } from './agentActivityStatusV1.js';

/**
 * Longest title a headline entry may carry.
 *
 * The headline is published into session metadata, which is encrypted, synced and read on every
 * cold open, so its size is a product cost paid by every client. A row renders one tail-truncated
 * line, and the untruncated title lives in the durable record the entry points at, so a bound this
 * generous is invisible in the UI and keeps a full roster in the low kilobytes. The workflow
 * headline's 4000-character bound is inherited from its snapshot schema and is not a precedent for
 * a per-entry roster.
 */
export const SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX = 200;

/**
 * One unit of agent work, as the compact headline describes it.
 *
 * **A pointer, not a record.** Identity, kind, title, status, timing and the ids needed to find the
 * real thing — and nothing else. No transcript, no preview, no summary, no payload, no counts
 * copied off a child. Detail already lives somewhere durable and indexed (a sidechain is queryable
 * by `sidechainId`; a workflow run has its `activity/workflow_run.v1` record), and a second copy in
 * session metadata would be a second authority that can disagree with the first.
 *
 * Two fields carry hard-won rules:
 *
 * - `startedAt` is OPTIONAL and must never be synthesised. A `startedAt ?? updatedAt ?? finishedAt`
 *   chain one layer up made a finished 16-second run report `0:00`. Absent evidence of a start, the
 *   field is absent and the surface shows nothing.
 * - `updatedAt` is the instant of the most recent EVIDENCE about this entry — not the instant the
 *   producer last rebuilt it, and specifically not a launch timestamp that never advances. It feeds
 *   terminal-history ordering here and the quiet/stale presentation downstream, both of which lie
 *   if it stands still while the work does not.
 */
export const SessionAgentActivityEntryV1Schema = z
  .object({
    /**
     * Stable across publishes for the same unit of work, and derived identically by every producer:
     * the merge that unions this headline with locally derived entries keys on it, so two spellings
     * of one agent become two rows.
     */
    entryId: z.string().trim().min(1),
    kind: AgentActivityKindV1Schema,
    title: z.string().trim().min(1).max(SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX),
    status: AgentActivityStatusV1Schema,
    /** Epoch ms. Absent when no genuine start is known — never back-filled from a finish. */
    startedAt: z.number().int().nonnegative().optional(),
    /** Epoch ms of the most recent evidence about this entry. */
    updatedAt: z.number().int().nonnegative(),
    /**
     * The durable sidechain holding this entry's transcript, when it has one.
     *
     * READ-ONLY IN THIS REPOSITORY FOR NOW. No producer here can populate it: a workflow agent's
     * sidechain id is only known to a sidecar transcript importer, which this repository does not
     * have yet, and minting one for an agent whose transcript was never imported would make the row
     * press into nothing. It stays in the schema because `../remote-dev` — the moving predecessor
     * frontier this repository must read (`docs/compatibility.md`) — already writes it, and a
     * strip-by-default schema without this field would silently discard it on every entry a
     * predecessor producer published.
     */
    sidechainId: z.string().trim().min(1).optional(),
    /** The run this entry belongs to or is, when the kind has one. */
    runId: z.string().trim().min(1).optional(),
    /** `entryId` of the owning entry. Authorises grouping and layout only — never numeric rollup. */
    parentId: z.string().trim().min(1).optional(),
    /**
     * Which version of the durable record this entry points at, when its producer versions one.
     *
     * The freshness half of "a pointer, not a record". Without it a consumer that hydrates the
     * durable record has to choose between refetching on every tick and never refetching, and a
     * consumer that hydrates `activity/workflow_run.v1` chose the latter — so a run hydrated once
     * and then froze while it kept looking live. This is what lets it refetch exactly when the
     * record it already holds became stale, and not otherwise.
     *
     * OPTIONAL and additive, in both directions that are reachable: a released producer that
     * predates the field omits it, and a released reader that predates it strips it. It therefore
     * may never be load-bearing for existence, status, ordering or bounding — only for cache
     * invalidation.
     *
     * OPAQUE: compared for equality, never parsed, ordered or differenced. The workflow producer
     * happens to write a monotonic decimal string, but that is its private contract with its own
     * record, not a promise every future kind's record has to keep.
     */
    recordRevision: z.string().trim().min(1).optional(),
  })
  // Strip unknown keys (Zod default, stated): a producer that attaches detail has it dropped on
  // parse as well as at the projection below. Forward-compatible fields are added explicitly.
  .strip();
export type SessionAgentActivityEntryV1 = z.infer<typeof SessionAgentActivityEntryV1Schema>;

/**
 * Narrow an entry to the headline field set.
 *
 * The producer-side half of the "headline never holds detail" invariant: structural typing lets a
 * caller pass a richer object, and this is the chokepoint that stops its extra fields reaching
 * session metadata regardless. It also clamps the title, so a producer cannot emit an entry that
 * its own schema would reject and that a reader would then silently drop.
 */
export function projectAgentActivityEntry(entry: SessionAgentActivityEntryV1): SessionAgentActivityEntryV1 {
  const title = entry.title.length > SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX
    ? entry.title.slice(0, SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX).trimEnd()
    : entry.title;
  const projected: SessionAgentActivityEntryV1 = {
    entryId: entry.entryId,
    kind: entry.kind,
    title,
    status: entry.status,
    updatedAt: entry.updatedAt,
  };
  if (entry.startedAt !== undefined) projected.startedAt = entry.startedAt;
  if (entry.sidechainId !== undefined) projected.sidechainId = entry.sidechainId;
  if (entry.runId !== undefined) projected.runId = entry.runId;
  if (entry.parentId !== undefined) projected.parentId = entry.parentId;
  if (entry.recordRevision !== undefined) projected.recordRevision = entry.recordRevision;
  return projected;
}

/**
 * Rank among ACTIVE entries; lower sorts first.
 *
 * `waiting` leads because it is the one status a person can clear right now — it is the only status
 * in the vocabulary that escalates. Then dependency-blocked, then live work, then work that has been
 * admitted but is not producing yet, then ambiguous. Terminal statuses sort last so that a caller
 * who hands this comparator a mixed array cannot bury a live entry under finished ones; they never
 * reach the active list through the builder.
 */
export function resolveAgentActivityEntryActivePriority(
  entry: Readonly<{ status: AgentActivityStatusV1 }>,
): number {
  switch (entry.status) {
    case 'waiting':
      return 0;
    case 'blocked':
      return 1;
    case 'running':
      return 2;
    case 'starting':
      return 3;
    case 'queued':
      return 4;
    case 'unknown':
      return 5;
    case 'succeeded':
    case 'failed':
    case 'timedOut':
    case 'cancelled':
      return 6;
    default: {
      const exhaustive: never = entry.status;
      return exhaustive;
    }
  }
}
