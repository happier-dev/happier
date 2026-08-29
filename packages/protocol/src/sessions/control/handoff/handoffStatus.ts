import { z } from 'zod';

import {
  SessionHandoffRecoveryActionSchema,
  SessionHandoffTransportStrategySchema,
  SessionHandoffWorkspaceTransferStrategySchema,
} from './handoffTypes.js';

const MAX_HANDOFF_ID_LENGTH = 256;
const MAX_JOB_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_DIGEST_LENGTH = 256;
const MAX_PHASE_DETAIL_LENGTH = 1024;
const MAX_PROGRESS_WARNINGS = 50;
const MAX_RECOVERY_ACTIONS = 50;
export const SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH = 2_000;

export const SessionHandoffPrepareTargetFailureCodeSchema = z.enum([
  'target_identity_conflict',
  'agent_version_unsupported',
]);
export type SessionHandoffPrepareTargetFailureCode = z.infer<
  typeof SessionHandoffPrepareTargetFailureCodeSchema
>;

export const SessionHandoffPrepareTargetFailureSchema = z.object({
  code: SessionHandoffPrepareTargetFailureCodeSchema,
  message: z.string().min(1).max(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH).optional(),
}).strict();
export type SessionHandoffPrepareTargetFailure = z.infer<
  typeof SessionHandoffPrepareTargetFailureSchema
>;

export const SessionHandoffPhaseSchema = z.enum([
  'preparing',
  'negotiating_transport',
  'staging_target',
  'cutover',
  'transferring',
  'importing',
  'resuming',
  'finalizing',
]);
export type SessionHandoffPhase = z.infer<typeof SessionHandoffPhaseSchema>;

export const SessionHandoffStatusCodeSchema = z.enum([
  'pending',
  'ready_for_cutover',
  'in_progress',
  'awaiting_user_resume',
  'reconciliation_required',
  'awaiting_recovery',
  'completed',
  'aborted',
  'failed',
]);
export type SessionHandoffStatusCode = z.infer<typeof SessionHandoffStatusCodeSchema>;

const SessionHandoffStatusTransportStrategySchema = z.union([
  SessionHandoffTransportStrategySchema,
  SessionHandoffWorkspaceTransferStrategySchema,
]);

export const SessionHandoffProgressCheckpointSchema = z.enum([
  'scan_source',
  'plan',
  'transfer_blobs',
  'stage_target',
  'apply',
  'import_session',
  'finalize',
]);
export type SessionHandoffProgressCheckpoint = z.infer<typeof SessionHandoffProgressCheckpointSchema>;

export const SESSION_HANDOFF_PROGRESS_TIMELINES_V1 = Object.freeze({
  minimal: [
    'stage_target',
    'import_session',
    'finalize',
  ],
  full: [
    'plan',
    'transfer_blobs',
    'stage_target',
    'apply',
    'import_session',
    'finalize',
  ],
  full_with_source_scan: [
    'scan_source',
    'plan',
    'transfer_blobs',
    'stage_target',
    'apply',
    'import_session',
    'finalize',
  ],
} as const satisfies Readonly<{
  minimal: readonly SessionHandoffProgressCheckpoint[];
  full: readonly SessionHandoffProgressCheckpoint[];
  full_with_source_scan: readonly SessionHandoffProgressCheckpoint[];
}>);

export const SESSION_HANDOFF_PROGRESS_MINIMAL_TIMELINE = SESSION_HANDOFF_PROGRESS_TIMELINES_V1.minimal;
export const SESSION_HANDOFF_PROGRESS_FULL_TIMELINE = SESSION_HANDOFF_PROGRESS_TIMELINES_V1.full;
export const SESSION_HANDOFF_PROGRESS_FULL_TIMELINE_WITH_SOURCE_SCAN = SESSION_HANDOFF_PROGRESS_TIMELINES_V1.full_with_source_scan;

export type SessionHandoffProgressTimelineKindV1 = keyof typeof SESSION_HANDOFF_PROGRESS_TIMELINES_V1;

export function resolveSessionHandoffProgressTimeline(
  checkpoint: SessionHandoffProgressCheckpoint | null | undefined,
): readonly SessionHandoffProgressCheckpoint[] {
  if (!checkpoint) {
    return SESSION_HANDOFF_PROGRESS_MINIMAL_TIMELINE;
  }
  if (checkpoint === 'scan_source') {
    return SESSION_HANDOFF_PROGRESS_FULL_TIMELINE_WITH_SOURCE_SCAN;
  }
  return checkpoint === 'plan' || checkpoint === 'transfer_blobs' || checkpoint === 'apply' || checkpoint === 'finalize'
    ? SESSION_HANDOFF_PROGRESS_FULL_TIMELINE
    : SESSION_HANDOFF_PROGRESS_MINIMAL_TIMELINE;
}

export const SessionHandoffProgressWarningCodeSchema = z.enum([
  'blocking_divergence_detected',
  'problematic_source_entries',
  'resumed_existing_job',
]);
export type SessionHandoffProgressWarningCode = z.infer<typeof SessionHandoffProgressWarningCodeSchema>;

const SessionHandoffProgressCountsSchema = z
  .object({
    files: z.number().int().min(0).optional(),
    bytes: z.number().int().min(0).optional(),
  })
  .passthrough();

export const SessionHandoffProgressSchema = z
  .object({
    updatedAtMs: z.number().int().min(0),
    checkpoint: SessionHandoffProgressCheckpointSchema,
    planned: z.object({
      totalFiles: z.number().int().min(0).optional(),
      totalBytes: z.number().int().min(0).optional(),
      added: z.number().int().min(0).optional(),
      changed: z.number().int().min(0).optional(),
      removed: z.number().int().min(0).optional(),
    }).passthrough(),
    transferred: z.object({
      files: z.number().int().min(0).optional(),
      bytes: z.number().int().min(0).optional(),
      blobs: z.number().int().min(0).optional(),
    }).passthrough(),
    applied: SessionHandoffProgressCountsSchema.optional(),
    remaining: SessionHandoffProgressCountsSchema.optional(),
    current: z.object({
      relativePath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
      digest: z.string().min(1).max(MAX_DIGEST_LENGTH).optional(),
      phaseDetail: z.string().min(1).max(MAX_PHASE_DETAIL_LENGTH).optional(),
    }).passthrough().optional(),
    resumable: z.boolean(),
    warnings: z.array(SessionHandoffProgressWarningCodeSchema).max(MAX_PROGRESS_WARNINGS).readonly().optional(),
  })
  .passthrough();
export type SessionHandoffProgress = z.infer<typeof SessionHandoffProgressSchema>;

export const SessionHandoffWorkspacePreflightSummarySchema = z
  .object({
    addedPathsCount: z.number().int().min(0),
    changedPathsCount: z.number().int().min(0),
    removedPathsCount: z.number().int().min(0),
    totalBytes: z.number().int().min(0).optional(),
  })
  .passthrough();
export type SessionHandoffWorkspacePreflightSummary = z.infer<typeof SessionHandoffWorkspacePreflightSummarySchema>;

export const SessionHandoffStatusSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusCodeSchema,
    phase: SessionHandoffPhaseSchema,
    jobId: z.string().min(1).max(MAX_JOB_ID_LENGTH).optional(),
    progress: SessionHandoffProgressSchema.optional(),
    workspacePreflightSummary: SessionHandoffWorkspacePreflightSummarySchema.optional(),
    transportStrategy: SessionHandoffStatusTransportStrategySchema.nullable().optional(),
    recoveryActions: z
      .array(SessionHandoffRecoveryActionSchema)
      .max(MAX_RECOVERY_ACTIONS)
      .readonly()
      .default(() => []),
    failure: SessionHandoffPrepareTargetFailureSchema.optional(),
  })
  .passthrough();
export type SessionHandoffStatus = z.infer<typeof SessionHandoffStatusSchema>;
