import { z } from 'zod';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX,
  SessionWorkflowRunStatusReasonV1Schema,
  SessionWorkflowRunStatusV1Schema,
} from './sessionWorkflowRunSnapshotV1.js';
import { SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN } from './sessionWorkflowRunRecordRevision.js';

/**
 * Compact, count-only headline for one workflow run.
 *
 * The headline is a derived live pointer published into session metadata. It carries only
 * the fields needed for compact UI display + cache invalidation: ids, title, status, exact
 * counts, and the durable-record pointer (`recordRevision`/`recordUpdatedAt`). Phase/agent
 * trees, previews, metrics, and raw payloads live only in the `activity/workflow_run.v1`
 * system record — never here.
 */
export const SessionWorkflowRunHeadlineV1Schema = z
  .object({
    runId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX),
    status: SessionWorkflowRunStatusV1Schema,
    statusReason: SessionWorkflowRunStatusReasonV1Schema.optional(),
    workflowToolUseId: z.string().trim().min(1).optional(),
    updatedAt: z.number().int().nonnegative(),
    recordRevision: z.string().trim().regex(SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN),
    recordUpdatedAt: z.number().int().nonnegative(),
    totalAgents: z.number().int().nonnegative(),
    completedAgents: z.number().int().nonnegative(),
    failedAgents: z.number().int().nonnegative().optional(),
    blockedAgents: z.number().int().nonnegative().optional(),
  })
  // Strip unknown keys (Zod default): the headline is a count-only pointer, so any leaked
  // phase/agent/preview detail is dropped on parse. Forward-compat fields are added explicitly.
  .strip();
export type SessionWorkflowRunHeadlineV1 = z.infer<typeof SessionWorkflowRunHeadlineV1Schema>;

export const SessionWorkflowActivityHeadlineTruncationV1Schema = z
  .object({
    reason: z.literal('run_limit'),
    omittedCount: z.number().int().nonnegative(),
  })
  .strip();
export type SessionWorkflowActivityHeadlineTruncationV1 = z.infer<typeof SessionWorkflowActivityHeadlineTruncationV1Schema>;

export const SessionWorkflowActivityHeadlineV1Schema = z
  .object({
    v: z.literal(1),
    backendId: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
    updatedAt: z.number().int().nonnegative(),
    primaryRunId: z.string().trim().min(1).nullable().optional(),
    activeRuns: z.array(SessionWorkflowRunHeadlineV1Schema),
    recentRuns: z.array(SessionWorkflowRunHeadlineV1Schema).optional(),
    truncated: SessionWorkflowActivityHeadlineTruncationV1Schema.optional(),
  })
  .strip();
export type SessionWorkflowActivityHeadlineV1 = z.infer<typeof SessionWorkflowActivityHeadlineV1Schema>;
