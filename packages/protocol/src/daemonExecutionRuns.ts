import { z } from 'zod';

import {
  ExecutionRunClassSchema,
  ExecutionRunDisplaySchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleSchema,
  ExecutionRunRetentionPolicySchema,
  ExecutionRunStatusSchema,
} from './executionRuns.js';
import { BackendTargetRefSchema } from './backendTargets/backendTargetRef.js';

/**
 * Daemon-scoped execution run listing.
 *
 * This is a machine-wide view of execution runs discovered via a daemon-readable
 * file registry. It is intentionally best-effort and may contain stale entries
 * if session processes crash or the machine reboots.
 */

const DaemonExecutionRunMarkerSchemaCore = z.object({
  // Safety/filtering: only accept markers for the current happyHomeDir.
  happyHomeDir: z.string().min(1),

  pid: z.number().int().positive(),
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  happySessionId: z.string().min(1),

  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefSchema,
  display: ExecutionRunDisplaySchema.optional(),

  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  retentionPolicy: ExecutionRunRetentionPolicySchema,

  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  lastActivityAtMs: z.number().int().nonnegative().optional(),

  summary: z.string().max(20_000).optional(),
  errorCode: z.string().max(200).optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
}).passthrough();
export const DaemonExecutionRunMarkerSchema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  DaemonExecutionRunMarkerSchemaCore,
);
export type DaemonExecutionRunMarker = z.infer<typeof DaemonExecutionRunMarkerSchema>;

export const DaemonExecutionRunProcessInfoSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().optional(),
  cmd: z.string().optional(),
  cpu: z.number().optional(),
  memory: z.number().optional(),
}).passthrough();
export type DaemonExecutionRunProcessInfo = z.infer<typeof DaemonExecutionRunProcessInfoSchema>;

const DaemonExecutionRunEntrySchemaCore = DaemonExecutionRunMarkerSchemaCore.extend({
  process: DaemonExecutionRunProcessInfoSchema.optional(),
}).passthrough();
export const DaemonExecutionRunEntrySchema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  DaemonExecutionRunEntrySchemaCore,
);
export type DaemonExecutionRunEntry = z.infer<typeof DaemonExecutionRunEntrySchema>;

export const DaemonExecutionRunListRequestSchema = z.object({}).passthrough();
export type DaemonExecutionRunListRequest = z.infer<typeof DaemonExecutionRunListRequestSchema>;

export const DaemonExecutionRunListResponseSchema = z.object({
  runs: z.array(DaemonExecutionRunEntrySchema),
}).passthrough();
export type DaemonExecutionRunListResponse = z.infer<typeof DaemonExecutionRunListResponseSchema>;
