import {
  isTerminalWorkflowRunStatus,
  parseSessionAgentActivityHeadlineV1,
  resolvePrimaryAgentActivityEntryId,
  resolvePrimaryWorkflowRunId,
  SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
  SessionWorkflowActivityHeadlineV1Schema,
  type SessionAgentActivityHeadlineV1,
  type SessionWorkflowRunHeadlineV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';

/**
 * Narrow migration repair for a historical Claude-only encoding bug that wrote async Agent rows as
 * empty workflow headlines. This predicate is shape-specific and never uses elapsed time; ordinary
 * non-terminal workflows are preserved until explicit lifecycle or authoritative inventory evidence.
 */
const LEGACY_AGENT_WORKFLOW_GHOST_MIN_COUNT = 2;
const LEGACY_AGENT_WORKFLOW_GHOST_TITLE = 'Workflow';

function isLegacyAsyncAgentWorkflowGhost(run: SessionWorkflowRunHeadlineV1): boolean {
  return (
    !isTerminalWorkflowRunStatus(run.status)
    && run.title === LEGACY_AGENT_WORKFLOW_GHOST_TITLE
    && run.totalAgents === 0
    && run.completedAgents === 0
    && run.runId.startsWith('toolu_')
    && run.workflowToolUseId === run.runId
  );
}

export function hasLegacyClaudeAsyncAgentWorkflowGhosts(metadata: Metadata | null | undefined): boolean {
  const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(metadata?.sessionWorkflowActivityHeadlineV1);
  if (!parsed.success || parsed.data.backendId !== 'claude') return false;
  return parsed.data.activeRuns.filter(isLegacyAsyncAgentWorkflowGhost).length >= LEGACY_AGENT_WORKFLOW_GHOST_MIN_COUNT;
}

export function pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata(
  metadata: Metadata,
  now: () => number = Date.now,
): Metadata {
  const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(metadata.sessionWorkflowActivityHeadlineV1);
  if (!parsed.success || parsed.data.backendId !== 'claude') return metadata;

  const activeRuns = parsed.data.activeRuns.filter((run) => !isLegacyAsyncAgentWorkflowGhost(run));
  if (activeRuns.length === parsed.data.activeRuns.length) return metadata;
  if ((parsed.data.activeRuns.length - activeRuns.length) < LEGACY_AGENT_WORKFLOW_GHOST_MIN_COUNT) return metadata;

  const repairedAt = now();
  const ghostRunIds = new Set(
    parsed.data.activeRuns.filter(isLegacyAsyncAgentWorkflowGhost).map((run) => run.runId),
  );

  return {
    ...metadata,
    sessionWorkflowActivityHeadlineV1: {
      ...parsed.data,
      updatedAt: repairedAt,
      primaryRunId: resolvePrimaryWorkflowRunId(activeRuns),
      activeRuns,
    },
    ...pruneGhostRunsFromAgentActivityHeadline(metadata, ghostRunIds, repairedAt),
  };
}

/**
 * Prune the SAME ghost runs out of the unified headline.
 *
 * The publisher writes both keys in one metadata update so they can never describe different worlds;
 * repairing only the workflow key would reintroduce that divergence at startup — and on the side the
 * roster actually renders. Entries are dropped by `runId`, which covers a ghost run's entry and any
 * agent entry beneath it (a ghost has none by definition, but the rule should not depend on that).
 *
 * Returns an empty patch when there is nothing to change, so the caller's identity check still holds.
 */
function pruneGhostRunsFromAgentActivityHeadline(
  metadata: Metadata,
  ghostRunIds: ReadonlySet<string>,
  repairedAt: number,
): Partial<Record<typeof SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY, SessionAgentActivityHeadlineV1>> {
  const headline = parseSessionAgentActivityHeadlineV1(
    (metadata as Record<string, unknown>)[SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY],
  );
  if (!headline || headline.backendId !== 'claude') return {};

  const keep = (entry: Readonly<{ runId?: string }>): boolean => (
    entry.runId === undefined || !ghostRunIds.has(entry.runId)
  );
  const activeEntries = headline.activeEntries.filter(keep);
  const recentEntries = headline.recentEntries?.filter(keep);
  const removed = (headline.activeEntries.length - activeEntries.length)
    + ((headline.recentEntries?.length ?? 0) - (recentEntries?.length ?? 0));
  if (removed === 0) return {};

  const repaired: SessionAgentActivityHeadlineV1 = {
    ...headline,
    updatedAt: repairedAt,
    primaryEntryId: resolvePrimaryAgentActivityEntryId(activeEntries),
    activeEntries,
  };
  if (recentEntries !== undefined) repaired.recentEntries = recentEntries;
  return { [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: repaired };
}
