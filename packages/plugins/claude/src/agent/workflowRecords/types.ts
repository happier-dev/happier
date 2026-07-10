/**
 * Claude-owned workflow normalizer constants + the per-event change observation (CWF2).
 *
 * The tracker is keyed PER RUN so two concurrent `Workflow` tool calls never merge their phases or
 * agents. The tracker's concrete internal run/phase/agent state lives in `tracker.ts` (mutable maps
 * for O(new events) updates); only the published `SessionWorkflowRunSnapshotV1` /
 * `SessionWorkflowActivityHeadlineV1` cross the boundary, so the internal shape is not re-declared
 * here to avoid a documentary copy that could drift.
 */

export const CLAUDE_WORKFLOW_BACKEND_ID = 'claude' as const;

/** Threshold above which uncorrelated subagents are promoted into an implicit "Agent activity" run. */
export const CLAUDE_IMPLICIT_WORKFLOW_AGENT_THRESHOLD = 2 as const;

/** Title used for the implicit run synthesized from >=2 correlated plain subagents. */
export const CLAUDE_IMPLICIT_WORKFLOW_RUN_TITLE = 'Agent activity' as const;

/** Deterministic run id for the single implicit per-session run. */
export const CLAUDE_IMPLICIT_WORKFLOW_RUN_ID = 'implicit:agent-activity' as const;

/**
 * Result of observing one raw transcript event: the run ids whose normalized snapshot changed
 * materially this event (so the publisher can debounce/coalesce per run), the run ids that were
 * created or changed status this event, and those that reached a terminal status (so the publisher
 * can flush immediately). All partitions are per-run so concurrent runs stay isolated.
 */
export type WorkflowActivityObservation = Readonly<{
  changedRunIds: readonly string[];
  startedRunIds: readonly string[];
  terminalRunIds: readonly string[];
  statusChangedRunIds: readonly string[];
  /**
   * Runs whose provider-liveness source was observed even when the durable workflow snapshot did
   * not materially change. This keeps runtime.activity source-keyed without forcing extra
   * workflow-run record writes for bookkeeping-only facts such as learning the provider task id.
   */
  runtimeActivityRunIds?: readonly string[];
}>;
