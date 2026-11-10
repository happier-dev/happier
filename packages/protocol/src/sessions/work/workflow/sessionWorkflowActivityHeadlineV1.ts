import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

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
export const SessionWorkflowRunHeadlineV1Schema = lazyZodSchema(() => z
  .object({
    runId: z.string().check(z.trim(), z.minLength(1)),
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX)),
    status: SessionWorkflowRunStatusV1Schema,
    statusReason: z.optional(SessionWorkflowRunStatusReasonV1Schema),
    workflowToolUseId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    recordRevision: z.string().check(z.trim(), z.regex(SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN)),
    recordUpdatedAt: z.number().check(z.int(), z.nonnegative()),
    totalAgents: z.number().check(z.int(), z.nonnegative()),
    completedAgents: z.number().check(z.int(), z.nonnegative()),
    failedAgents: z.optional(z.number().check(z.int(), z.nonnegative())),
    blockedAgents: z.optional(z.number().check(z.int(), z.nonnegative())),
  }));
export type SessionWorkflowRunHeadlineV1 = z.infer<typeof SessionWorkflowRunHeadlineV1Schema>;

export const SessionWorkflowActivityHeadlineTruncationV1Schema = lazyZodSchema(() => z
  .object({
    reason: z.literal('run_limit'),
    omittedCount: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionWorkflowActivityHeadlineTruncationV1 = z.infer<typeof SessionWorkflowActivityHeadlineTruncationV1Schema>;

export const SessionWorkflowActivityHeadlineV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    backendId: z.string().check(z.trim(), z.minLength(1)),
    agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    primaryRunId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    activeRuns: z.array(SessionWorkflowRunHeadlineV1Schema),
    recentRuns: z.optional(z.array(SessionWorkflowRunHeadlineV1Schema)),
    truncated: z.optional(SessionWorkflowActivityHeadlineTruncationV1Schema),
  }));
export type SessionWorkflowActivityHeadlineV1 = z.infer<typeof SessionWorkflowActivityHeadlineV1Schema>;
