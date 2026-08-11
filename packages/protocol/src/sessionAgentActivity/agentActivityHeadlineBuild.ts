import {
  boundRecentActivityHeadlineEntries,
  partitionActivityHeadlineEntries,
  sortActiveActivityHeadlineEntries,
  type ActivityHeadlineEntryAccessors,
} from '../sessionActivityHeadlineOrdering.js';
import {
  projectAgentActivityEntry,
  resolveAgentActivityEntryActivePriority,
  type SessionAgentActivityEntryV1,
} from './agentActivityEntryV1.js';
import { isTerminalAgentActivityStatus } from './agentActivityStatusV1.js';
import type {
  SessionAgentActivityHeadlineTruncationV1,
  SessionAgentActivityHeadlineV1,
} from './agentActivityHeadlineV1.js';

/**
 * Default terminal-history bound for the compact metadata headline.
 *
 * Only `recentEntries` is bounded; `activeEntries` is never capped, for the reason stated in
 * `../sessionActivityHeadlineOrdering.ts`. The value matches the roster pane's own in-pane finished
 * cap (24) so the transport is never the thing that starves the surface: a pane that offers to show
 * 24 finished rows can actually be given 24. Producers may lower it; nothing may cap the active
 * side. Terminal detail stays durable in the records the entries point at.
 */
export const SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT = 24;

/**
 * How the shared headline-ordering owner reads an agent-activity entry.
 *
 * Terminality, priority and projection are this vocabulary's decisions; ordering, bounding and the
 * "progress timestamps never touch the active side" rule belong to
 * `../sessionActivityHeadlineOrdering.ts`, which the workflow headline calls with its own accessors.
 * One mechanism, two vocabularies — never two comparators.
 */
const AGENT_ACTIVITY_ENTRY_ACCESSORS: ActivityHeadlineEntryAccessors<SessionAgentActivityEntryV1> = {
  id: (entry) => entry.entryId,
  activePriority: resolveAgentActivityEntryActivePriority,
  updatedAt: (entry) => entry.updatedAt,
};

/** Deterministic active ordering, so every client agrees on the sequence and on `primaryEntryId`. */
export function sortActiveAgentActivityEntries(
  entries: readonly SessionAgentActivityEntryV1[],
): SessionAgentActivityEntryV1[] {
  return sortActiveActivityHeadlineEntries(entries, AGENT_ACTIVITY_ENTRY_ACCESSORS);
}

/** Bound only terminal history; never bound live work. */
export function boundRecentAgentActivityEntries(
  terminalEntries: readonly SessionAgentActivityEntryV1[],
  limit: number = SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT,
): { recentEntries: SessionAgentActivityEntryV1[]; truncated?: SessionAgentActivityHeadlineTruncationV1 } {
  const { recent, omittedCount } = boundRecentActivityHeadlineEntries(
    terminalEntries,
    AGENT_ACTIVITY_ENTRY_ACCESSORS,
    limit,
  );
  if (omittedCount > 0) {
    return { recentEntries: recent, truncated: { reason: 'entry_limit', omittedCount } };
  }
  return { recentEntries: recent };
}

/**
 * `primaryEntryId` is a derived hint, not a second source of truth: `null` when nothing is live,
 * otherwise the first entry after deterministic active ordering.
 */
export function resolvePrimaryAgentActivityEntryId(
  activeEntries: readonly SessionAgentActivityEntryV1[],
): string | null {
  return sortActiveAgentActivityEntries(activeEntries)[0]?.entryId ?? null;
}

export type BuildSessionAgentActivityHeadlineInput = Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  /** Every currently-known entry, live and terminal, in any order. */
  entries: readonly SessionAgentActivityEntryV1[];
  recentEntriesLimit?: number;
}>;

/**
 * Build the compact headline from a flat list of entries.
 *
 * The single shared builder for this key: the CLI publisher, any test fixture and `../dev` all go
 * through it, so ordering, bounding and the count-only projection cannot diverge between the
 * producer and whatever else assembles a headline.
 */
export function buildSessionAgentActivityHeadline(
  input: BuildSessionAgentActivityHeadlineInput,
): SessionAgentActivityHeadlineV1 {
  const { active, recent, omittedCount } = partitionActivityHeadlineEntries({
    entries: input.entries,
    accessors: AGENT_ACTIVITY_ENTRY_ACCESSORS,
    isTerminal: (entry) => isTerminalAgentActivityStatus(entry.status),
    // Project at the single producer chokepoint so detail can never reach the headline.
    project: projectAgentActivityEntry,
    recentLimit: input.recentEntriesLimit ?? SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT,
  });

  const headline: SessionAgentActivityHeadlineV1 = {
    v: 1,
    backendId: input.backendId,
    updatedAt: input.updatedAt,
    primaryEntryId: active[0]?.entryId ?? null,
    activeEntries: active,
  };
  if (input.agentId) headline.agentId = input.agentId;
  if (recent.length > 0) headline.recentEntries = recent;
  if (omittedCount > 0) headline.truncated = { reason: 'entry_limit', omittedCount };
  return headline;
}
