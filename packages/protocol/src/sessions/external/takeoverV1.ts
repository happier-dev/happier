import { z } from 'zod';

import { SessionIdSchema } from '../idsV1.js';
import { HappierManagedSessionRuntimeModeV1Schema } from '../runtimeModeV1.js';

export const ExternalSessionTakeoverStorageModeV1Schema = z.enum(['external-linked', 'persisted']);
export type ExternalSessionTakeoverStorageModeV1 = z.infer<typeof ExternalSessionTakeoverStorageModeV1Schema>;

export const ExternalSessionTakeoverInputV1Schema = z.object({
  linkedSessionId: SessionIdSchema,
  targetRuntimeMode: HappierManagedSessionRuntimeModeV1Schema,
  storageMode: ExternalSessionTakeoverStorageModeV1Schema,
  forceStop: z.boolean().optional(),
}).passthrough();
export type ExternalSessionTakeoverInputV1 = z.infer<typeof ExternalSessionTakeoverInputV1Schema>;

export const ExternalSessionTakeoverErrorCodeV1Schema = z.enum([
  'machine_offline',
  'session_not_found',
  'invalid_external_source',
  'takeover_not_available',
  'force_stop_required',
  'transcript_import_failed',
  'spawn_failed',
  'capability_unsupported',
]);
export type ExternalSessionTakeoverErrorCodeV1 = z.infer<typeof ExternalSessionTakeoverErrorCodeV1Schema>;

export const ExternalSessionTakeoverResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    sessionId: SessionIdSchema,
    targetRuntimeMode: HappierManagedSessionRuntimeModeV1Schema,
    storageMode: ExternalSessionTakeoverStorageModeV1Schema,
    converted: z.boolean(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: ExternalSessionTakeoverErrorCodeV1Schema,
    error: z.string(),
    trustedPid: z.number().int().positive().optional(),
  }).passthrough(),
]);
export type ExternalSessionTakeoverResultV1 = z.infer<typeof ExternalSessionTakeoverResultV1Schema>;
