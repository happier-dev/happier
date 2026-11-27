import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/**
 * Why a capture that stopped cleanly was not saved, named by the recording file's fate:
 * - `workspace_write_failed`: it could not be written into the Session's workspace; the encoded file was deleted.
 * - `transcript_attach_failed`: it was written into the Session's workspace on that Machine and kept there,
 *   but could not be added to the Session's transcript.
 */
export const RecordingSaveFailureV1Schema = lazyZodSchema(() => z.enum(['workspace_write_failed', 'transcript_attach_failed']));
export type RecordingSaveFailureV1 = z.infer<typeof RecordingSaveFailureV1Schema>;

/** One lifecycle result shape for every frame source, including the shipped Browser IPC. */
export function createRecordingResultSchemas<R extends z.ZodMiniType, O extends z.ZodMiniType, U extends z.ZodMiniType>(
  session: R, outcomeReason: O, unavailableReason: U,
) {
  const unavailable = lazyZodSchema(() => z.strictObject({ status: z.literal('unavailable'), reason: unavailableReason }));
  return {
    start: lazyZodSchema(() => z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('started'), recording: session }), unavailable,
    ])),
    stop: lazyZodSchema(() => z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('finalized'), recording: session }),
      z.strictObject({ status: z.literal('failed'), recording: session, reason: outcomeReason,
        failureCause: z.optional(ActionFailureCauseV1Schema), requestId: z.optional(z.string()),
        saveFailure: z.optional(RecordingSaveFailureV1Schema) }), unavailable,
    ])),
    terminal: lazyZodSchema(() => z.discriminatedUnion('status', [
      z.strictObject({ status: z.enum(['failed', 'canceled', 'discarded']), recording: session }), unavailable,
    ])),
  };
}
