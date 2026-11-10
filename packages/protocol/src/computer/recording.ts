import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ComputerTargetRequestV1Schema, ComputerTargetV1Schema, ComputerSourceIdentityV1Schema } from './v1.js';
import { RecordingSessionFieldsV1Schema, validateRecordingSessionV1, BrowserRecordingSessionMediaTargetV1Schema,
  BrowserRecordingRetentionClassV1Schema } from '../browser/recording/v1.js';

export const ComputerRecordingSessionV1Schema = lazyZodSchema(() => z.strictObject({
  ...RecordingSessionFieldsV1Schema.shape,
  machineId: ComputerTargetRequestV1Schema.shape.machineId,
  sourceId: ComputerTargetRequestV1Schema.shape.machineId,
  sourceIdentity: ComputerSourceIdentityV1Schema,
  desktopKey: z.optional(ComputerTargetRequestV1Schema.shape.machineId),
  target: ComputerTargetV1Schema,
  mediaTarget: BrowserRecordingSessionMediaTargetV1Schema,
}).check(z.superRefine(validateRecordingSessionV1)));
export type ComputerRecordingSessionV1 = z.infer<typeof ComputerRecordingSessionV1Schema>;

export const ComputerRecordingStartInputV1Schema = lazyZodSchema(() => z.extend(ComputerTargetRequestV1Schema, {
  mediaTarget: BrowserRecordingSessionMediaTargetV1Schema,
  retentionClass: z._default(z.optional(BrowserRecordingRetentionClassV1Schema), 'preSend'),
}));
export const ComputerRecordingTargetInputV1Schema = lazyZodSchema(() => z.extend(ComputerTargetRequestV1Schema, {
  sourceId: ComputerTargetRequestV1Schema.shape.machineId,
}));
export const ComputerRecordingIdInputV1Schema = lazyZodSchema(() => z.extend(ComputerRecordingTargetInputV1Schema, {
  recordingId: RecordingSessionFieldsV1Schema.shape.recordingId,
}));
export const ComputerRecordingStopInputV1Schema = lazyZodSchema(() => z.extend(ComputerRecordingIdInputV1Schema, {
  expiresAtMs: RecordingSessionFieldsV1Schema.shape.expiresAtMs,
}));
export const ComputerRecordingAttachInputV1Schema = lazyZodSchema(() => z.extend(ComputerRecordingIdInputV1Schema, {
  sessionId: z.optional(BrowserRecordingSessionMediaTargetV1Schema.shape.sessionId),
}));
