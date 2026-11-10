import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

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
      z.strictObject({ status: z.literal('failed'), recording: session, reason: outcomeReason }), unavailable,
    ])),
    terminal: lazyZodSchema(() => z.discriminatedUnion('status', [
      z.strictObject({ status: z.enum(['failed', 'canceled', 'discarded']), recording: session }), unavailable,
    ])),
  };
}
