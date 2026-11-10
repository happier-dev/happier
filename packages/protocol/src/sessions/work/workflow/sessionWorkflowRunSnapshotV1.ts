import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

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
 * Claude-owned plugin code; protocol never parses provider-native events.
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

export const SessionWorkflowRunStatusV1Schema = lazyZodSchema(() => z.enum([
  'active',
  'complete',
  'failed',
  'stopped',
  'blocked',
  'cancelled',
  'unknown',
]));
export type SessionWorkflowRunStatusV1 = z.infer<typeof SessionWorkflowRunStatusV1Schema>;

export const SessionWorkflowRunStatusReasonV1Schema = lazyZodSchema(() => z.enum(['interrupted']));
export type SessionWorkflowRunStatusReasonV1 = z.infer<typeof SessionWorkflowRunStatusReasonV1Schema>;

export const SessionWorkflowAgentStatusV1Schema = lazyZodSchema(() => z.enum([
  'pending',
  'active',
  'complete',
  'failed',
  'blocked',
  'cancelled',
  'unknown',
]));
export type SessionWorkflowAgentStatusV1 = z.infer<typeof SessionWorkflowAgentStatusV1Schema>;

export const SessionWorkflowPhaseSnapshotV1Schema = lazyZodSchema(() => z.looseObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    title: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX))),
    order: z.optional(z.number().check(z.int(), z.nonnegative())),
    agentIds: z.array(z.string().check(z.trim(), z.minLength(1))),
  }));
export type SessionWorkflowPhaseSnapshotV1 = z.infer<typeof SessionWorkflowPhaseSnapshotV1Schema>;

export const SessionWorkflowAgentSnapshotV1Schema = lazyZodSchema(() => z.looseObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX)),
    status: SessionWorkflowAgentStatusV1Schema,
    vendorRef: z.optional(z.string().check(z.trim(), z.minLength(1))),
    parentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    phaseIndex: z.optional(z.number().check(z.int())),
    phaseTitle: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX))),
    model: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(400))),
    summary: z.optional(z.string().check(z.trim(), z.maxLength(SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX))),
    resultPreview: z.optional(z.string().check(z.trim(), z.maxLength(SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX))),
    tokensUsed: z.optional(z.number().check(z.int(), z.nonnegative())),
    toolCalls: z.optional(z.number().check(z.int(), z.nonnegative())),
    timeUsedSeconds: z.optional(z.number().check(z.nonnegative())),
    startedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    completedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionWorkflowAgentSnapshotV1 = z.infer<typeof SessionWorkflowAgentSnapshotV1Schema>;

export const SessionWorkflowRunSnapshotV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    projectionVersion: z.literal(SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION),
    runId: z.string().check(z.trim(), z.minLength(1)),
    backendId: z.string().check(z.trim(), z.minLength(1)),
    agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX)),
    status: SessionWorkflowRunStatusV1Schema,
    statusReason: z.optional(SessionWorkflowRunStatusReasonV1Schema),
    vendorRef: z.optional(z.string().check(z.trim(), z.minLength(1))),
    workflowToolUseId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    sourceSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    sourceRevision: z.optional(z.string().check(z.trim(), z.minLength(1))),
    recordRevision: z.string().check(z.trim(), z.regex(SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN)),
    startedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    completedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    totalAgents: z.number().check(z.int(), z.nonnegative()),
    completedAgents: z.number().check(z.int(), z.nonnegative()),
    failedAgents: z.optional(z.number().check(z.int(), z.nonnegative())),
    blockedAgents: z.optional(z.number().check(z.int(), z.nonnegative())),
    cancelledAgents: z.optional(z.number().check(z.int(), z.nonnegative())),
    tokensUsed: z.optional(z.number().check(z.int(), z.nonnegative())),
    toolCalls: z.optional(z.number().check(z.int(), z.nonnegative())),
    timeUsedSeconds: z.optional(z.number().check(z.nonnegative())),
    phases: z.array(SessionWorkflowPhaseSnapshotV1Schema),
    agents: z.array(SessionWorkflowAgentSnapshotV1Schema),
  }));
export type SessionWorkflowRunSnapshotV1 = z.infer<typeof SessionWorkflowRunSnapshotV1Schema>;
