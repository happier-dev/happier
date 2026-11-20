import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import {
  SessionHandoffRecoveryActionSchema,
  SessionHandoffTransportStrategySchema,
} from './handoffTypes.js';

/** A failed tracked handoff may carry the source's confirmed stop. */
export const SessionHandoffSourceStoppedV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session_handoff_source_stopped'),
}));

const MAX_HANDOFF_ID_LENGTH = 256;
const MAX_JOB_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_DIGEST_LENGTH = 256;
const MAX_PHASE_DETAIL_LENGTH = 1024;
const MAX_PROGRESS_WARNINGS = 50;
const MAX_RECOVERY_ACTIONS = 50;
export const SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH = 2_000;

export const SessionHandoffPrepareTargetFailureCodeSchema = lazyZodSchema(() => z.enum([
  'target_identity_conflict',
  'agent_version_unsupported',
  'existing_session_state_unavailable',
  'existing_session_state_unsupported',
]));
export type SessionHandoffPrepareTargetFailureCode = z.infer<
  typeof SessionHandoffPrepareTargetFailureCodeSchema
>;

export const SessionHandoffPrepareTargetFailureSchema = lazyZodSchema(() => z.strictObject({
  code: SessionHandoffPrepareTargetFailureCodeSchema,
  message: z.optional(z.string().check(z.minLength(1), z.maxLength(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH))),
}));
export type SessionHandoffPrepareTargetFailure = z.infer<
  typeof SessionHandoffPrepareTargetFailureSchema
>;

export const SessionHandoffPhaseSchema = lazyZodSchema(() => z.enum([
  'preparing',
  'negotiating_transport',
  'staging_target',
  'cutover',
  'transferring',
  'importing',
  'resuming',
  'finalizing',
]));
export type SessionHandoffPhase = z.infer<typeof SessionHandoffPhaseSchema>;

export const SessionHandoffStatusCodeSchema = lazyZodSchema(() => z.enum([
  'pending',
  'ready_for_cutover',
  'in_progress',
  'awaiting_user_resume',
  'reconciliation_required',
  'awaiting_recovery',
  'completed',
  'aborted',
  'failed',
]));
export type SessionHandoffStatusCode = z.infer<typeof SessionHandoffStatusCodeSchema>;

export const SessionHandoffProgressCheckpointSchema = lazyZodSchema(() => z.enum([
  'scan_source',
  'plan',
  'transfer_blobs',
  'stage_target',
  'apply',
  'import_session',
  'finalize',
]));
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

export const SessionHandoffProgressWarningCodeSchema = lazyZodSchema(() => z.enum([
  'blocking_divergence_detected',
  'problematic_source_entries',
  'resumed_existing_job',
]));
export type SessionHandoffProgressWarningCode = z.infer<typeof SessionHandoffProgressWarningCodeSchema>;

const SessionHandoffProgressCountsSchema = lazyZodSchema(() => z.looseObject({
    files: z.optional(z.number().check(z.int(), z.minimum(0))),
    bytes: z.optional(z.number().check(z.int(), z.minimum(0))),
  }));

export const SessionHandoffProgressSchema = lazyZodSchema(() => z.looseObject({
    updatedAtMs: z.number().check(z.int(), z.minimum(0)),
    checkpoint: SessionHandoffProgressCheckpointSchema,
    planned: z.looseObject({
      totalFiles: z.optional(z.number().check(z.int(), z.minimum(0))),
      totalBytes: z.optional(z.number().check(z.int(), z.minimum(0))),
      added: z.optional(z.number().check(z.int(), z.minimum(0))),
      changed: z.optional(z.number().check(z.int(), z.minimum(0))),
      removed: z.optional(z.number().check(z.int(), z.minimum(0))),
    }),
    transferred: z.looseObject({
      files: z.optional(z.number().check(z.int(), z.minimum(0))),
      bytes: z.optional(z.number().check(z.int(), z.minimum(0))),
      blobs: z.optional(z.number().check(z.int(), z.minimum(0))),
    }),
    applied: z.optional(SessionHandoffProgressCountsSchema),
    remaining: z.optional(SessionHandoffProgressCountsSchema),
    current: z.optional(z.looseObject({
      relativePath: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH))),
      digest: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_DIGEST_LENGTH))),
      phaseDetail: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_PHASE_DETAIL_LENGTH))),
    })),
    resumable: z.boolean(),
    warnings: z.optional(z.readonly(z.array(SessionHandoffProgressWarningCodeSchema).check(z.maxLength(MAX_PROGRESS_WARNINGS)))),
  }));
export type SessionHandoffProgress = z.infer<typeof SessionHandoffProgressSchema>;

export const SessionHandoffWorkspacePreflightSummarySchema = lazyZodSchema(() => z.looseObject({
    addedPathsCount: z.number().check(z.int(), z.minimum(0)),
    changedPathsCount: z.number().check(z.int(), z.minimum(0)),
    removedPathsCount: z.number().check(z.int(), z.minimum(0)),
    totalBytes: z.optional(z.number().check(z.int(), z.minimum(0))),
  }));
export type SessionHandoffWorkspacePreflightSummary = z.infer<typeof SessionHandoffWorkspacePreflightSummarySchema>;

export const SessionHandoffStatusSchema = lazyZodSchema(() => z.looseObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    status: SessionHandoffStatusCodeSchema,
    phase: SessionHandoffPhaseSchema,
    jobId: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_JOB_ID_LENGTH))),
    progress: z.optional(SessionHandoffProgressSchema),
    workspacePreflightSummary: z.optional(SessionHandoffWorkspacePreflightSummarySchema),
    transportStrategy: z.optional(z.nullable(SessionHandoffTransportStrategySchema)),
    recoveryActions: z._default(z.readonly(z
      .array(SessionHandoffRecoveryActionSchema).check(z.maxLength(MAX_RECOVERY_ACTIONS))), () => []),
    failure: z.optional(SessionHandoffPrepareTargetFailureSchema),
  }));
export type SessionHandoffStatus = z.infer<typeof SessionHandoffStatusSchema>;
