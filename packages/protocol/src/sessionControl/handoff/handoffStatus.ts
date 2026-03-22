import { z } from 'zod';

import {
  SessionHandoffRecoveryActionSchema,
  SessionHandoffTransportStrategySchema,
} from './handoffTypes.js';

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
  'awaiting_recovery',
  'completed',
  'aborted',
  'failed',
]);
export type SessionHandoffStatusCode = z.infer<typeof SessionHandoffStatusCodeSchema>;

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

export const SessionHandoffProgressWarningCodeSchema = z.enum([
  'blocking_divergence_detected',
  'problematic_source_entries',
  'resumed_existing_job',
]);
export type SessionHandoffProgressWarningCode = z.infer<typeof SessionHandoffProgressWarningCodeSchema>;

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
    }).strict(),
    transferred: z.object({
      files: z.number().int().min(0).optional(),
      bytes: z.number().int().min(0).optional(),
      blobs: z.number().int().min(0).optional(),
    }).strict(),
    current: z.object({
      relativePath: z.string().min(1).optional(),
      digest: z.string().min(1).optional(),
      phaseDetail: z.string().min(1).optional(),
    }).strict().optional(),
    resumable: z.boolean(),
    warnings: z.array(SessionHandoffProgressWarningCodeSchema).optional(),
  })
  .strict();
export type SessionHandoffProgress = z.infer<typeof SessionHandoffProgressSchema>;

export const SessionHandoffWorkspacePreflightSummarySchema = z
  .object({
    addedPathsCount: z.number().int().min(0),
    changedPathsCount: z.number().int().min(0),
    removedPathsCount: z.number().int().min(0),
    totalBytes: z.number().int().min(0).optional(),
  })
  .strict();
export type SessionHandoffWorkspacePreflightSummary = z.infer<typeof SessionHandoffWorkspacePreflightSummarySchema>;

export const SessionHandoffStatusSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusCodeSchema,
    phase: SessionHandoffPhaseSchema,
    jobId: z.string().min(1).optional(),
    progress: SessionHandoffProgressSchema.optional(),
    workspacePreflightSummary: SessionHandoffWorkspacePreflightSummarySchema.optional(),
    transportStrategy: SessionHandoffTransportStrategySchema.nullable().optional(),
    recoveryActions: z.array(SessionHandoffRecoveryActionSchema).default([]),
  })
  .strict();
export type SessionHandoffStatus = z.infer<typeof SessionHandoffStatusSchema>;
