import {
  PendingRequestedActionV1Schema,
} from '@happier-dev/protocol';
import { z } from 'zod';
import {
  TrackedSessionTurnLifecycleResultSchema,
  type TrackedSessionTurnLifecycleResult,
} from '../sessions/applyTrackedSessionTurnLifecycle';

export const ConnectedServiceTurnLifecycleRequestBodySchema =
  z.object({
    sessionId: z.string().min(1),
    turnId: z.string().trim().min(1).max(512).optional(),
    event: z.enum([
      'prompt_or_steer',
      'task_started',
      'assistant_message_end',
      'turn_cancelled',
    ]),
    terminalStatus: z.enum(['completed', 'failed'])
      .optional(),
    connectedServiceSelectionsEnvRaw: z.string()
      .min(1)
      .max(64 * 1024)
      .optional(),
    requestedAction: PendingRequestedActionV1Schema.optional(),
    activeTurnId: z.string()
      .trim()
      .min(1)
      .max(512)
      .nullable()
      .optional(),
  }).strict();

export type ConnectedServiceTurnLifecycleRequestBody =
  z.infer<
    typeof ConnectedServiceTurnLifecycleRequestBodySchema
  >;

export const ConnectedServiceTurnLifecycleResultSchema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('continue'),
      turnCustody: TrackedSessionTurnLifecycleResultSchema,
    }).strict(),
    z.object({
      status: z.literal('input_blocked'),
      reason: z.literal('request_auth_source_cutover'),
    }).strict(),
  ]);

export type ConnectedServiceTurnLifecycleResult =
  z.infer<typeof ConnectedServiceTurnLifecycleResultSchema>;

export function connectedServiceTurnLifecycleContinue(
  turnCustody: TrackedSessionTurnLifecycleResult,
): ConnectedServiceTurnLifecycleResult {
  return {
    status: 'continue',
    turnCustody,
  };
}

export const CONNECTED_SERVICE_TURN_LIFECYCLE_SOURCE_CUTOVER_BLOCK =
  Object.freeze({
    status: 'input_blocked',
    reason: 'request_auth_source_cutover',
  } satisfies ConnectedServiceTurnLifecycleResult);
