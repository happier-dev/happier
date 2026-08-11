import { z } from 'zod';

import { SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN } from './sessionWorkflowRunRecordRevision.js';

/**
 * Provider-agnostic durable workflow run snapshot.
 *
 * Persisted as a session system record under namespace `activity`, kind `workflow_run.v1`.
 * One record holds the full detail for one workflow run: ordered `phases[]` and all
 * `agents[]`. Hundreds of agents must round-trip without dropping ids or corrupting counts,
 * so the schema bounds only preview strings — never ids, status, counters, or exact counts.
 *
 * This contract is provider-neutral. Claude-native event shapes (`task_progress`,
 * `workflow_progress[]`, `Workflow {script}`) are normalized into these fields by
 * Claude-owned CLI code; protocol never parses provider-native events.
 */

export const SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX = 8000;
export const SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX = 2000;
export const SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX = 4000;
/**
 * Provider-agnostic projection/normalizer version for durable workflow run records.
 * Required separately from schema `v` so pre-version, valid-but-stale workflow projections are
 * rejected without changing provider-native Claude event parsing.
 */
export const SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION = 1;

export const SessionWorkflowRunStatusV1Schema = z.enum([
  'active',
  'complete',
  'failed',
  'stopped',
  'blocked',
  'cancelled',
  'unknown',
]);
export type SessionWorkflowRunStatusV1 = z.infer<typeof SessionWorkflowRunStatusV1Schema>;

/**
 * Optional reason qualifier for a workflow run's status. Additive and forward-compatible:
 * today only `interrupted` is emitted (a run that was `active`/`blocked`/`unknown` when the CLI
 * process died or shut down and was synthetically terminated to `stopped` by startup
 * reconciliation / graceful teardown). Clients may render a distinct tone; absence means the
 * status was reached by a real provider transition.
 */
export const SessionWorkflowRunStatusReasonV1Schema = z.enum([
  'interrupted',
]);
export type SessionWorkflowRunStatusReasonV1 = z.infer<typeof SessionWorkflowRunStatusReasonV1Schema>;

export const SessionWorkflowAgentStatusV1Schema = z.enum([
  'pending',
  'active',
  'complete',
  'failed',
  'blocked',
  'cancelled',
  'unknown',
]);
export type SessionWorkflowAgentStatusV1 = z.infer<typeof SessionWorkflowAgentStatusV1Schema>;

export const SessionWorkflowPhaseSnapshotV1Schema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1).max(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX).optional(),
    order: z.number().int().nonnegative().optional(),
    agentIds: z.array(z.string().trim().min(1)),
  })
  .passthrough();
export type SessionWorkflowPhaseSnapshotV1 = z.infer<typeof SessionWorkflowPhaseSnapshotV1Schema>;

export const SessionWorkflowAgentSnapshotV1Schema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1).max(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX),
    status: SessionWorkflowAgentStatusV1Schema,
    vendorRef: z.string().trim().min(1).optional(),
    /**
     * The durable sidechain holding this agent's own transcript, when one was IMPORTED for it.
     *
     * The open target, and the only one an agent of a workflow can have: a plain subagent is opened
     * through the tool call that spawned it, but a workflow run has one `Workflow` tool call and
     * many agents, so there is no per-agent tool call to route through. A client that has this can
     * fetch the transcript by id; a client that does not must treat the row as unopenable.
     *
     * PRESENT ONLY AS PROOF, never as intent. It is written when the importer actually registered
     * the agent's sidecar file, so absence means "no transcript to open" rather than "not yet" —
     * a producer that minted it optimistically would make every row pressable and some of them
     * open nothing. Optional and additive in both reachable directions: every released producer
     * omits it (the live case today), and a released reader that predates it strips it.
     */
    sidechainId: z.string().trim().min(1).optional(),
    parentId: z.string().trim().min(1).optional(),
    phaseIndex: z.number().int().optional(),
    phaseTitle: z.string().trim().min(1).max(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX).optional(),
    model: z.string().trim().min(1).max(400).optional(),
    summary: z.string().trim().max(SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX).optional(),
    resultPreview: z.string().trim().max(SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX).optional(),
    tokensUsed: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    timeUsedSeconds: z.number().finite().nonnegative().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    completedAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .passthrough();
export type SessionWorkflowAgentSnapshotV1 = z.infer<typeof SessionWorkflowAgentSnapshotV1Schema>;

export const SessionWorkflowRunSnapshotV1Schema = z
  .object({
    v: z.literal(1),
    projectionVersion: z.literal(SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION),
    runId: z.string().trim().min(1),
    backendId: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).max(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX),
    status: SessionWorkflowRunStatusV1Schema,
    statusReason: SessionWorkflowRunStatusReasonV1Schema.optional(),
    vendorRef: z.string().trim().min(1).optional(),
    workflowToolUseId: z.string().trim().min(1).optional(),
    sourceSessionId: z.string().trim().min(1).optional(),
    sourceRevision: z.string().trim().min(1).optional(),
    recordRevision: z.string().trim().regex(SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN),
    startedAt: z.number().int().nonnegative().optional(),
    completedAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
    totalAgents: z.number().int().nonnegative(),
    completedAgents: z.number().int().nonnegative(),
    failedAgents: z.number().int().nonnegative().optional(),
    blockedAgents: z.number().int().nonnegative().optional(),
    cancelledAgents: z.number().int().nonnegative().optional(),
    tokensUsed: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    timeUsedSeconds: z.number().finite().nonnegative().optional(),
    phases: z.array(SessionWorkflowPhaseSnapshotV1Schema),
    agents: z.array(SessionWorkflowAgentSnapshotV1Schema),
  })
  .passthrough();
export type SessionWorkflowRunSnapshotV1 = z.infer<typeof SessionWorkflowRunSnapshotV1Schema>;
