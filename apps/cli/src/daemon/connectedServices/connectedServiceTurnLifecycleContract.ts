import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { z } from 'zod/mini';
import {
  TrackedSessionTurnLifecycleResultSchema,
  type TrackedSessionTurnLifecycleResult,
} from '../sessions/applyTrackedSessionTurnLifecycle';

export const ConnectedServiceTurnLifecycleRequestBodySchema =
  lazyZodSchema(() => z.strictObject({
    sessionId: z.string().check(z.minLength(1)),
    turnId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    event: z.enum([
      'prompt_or_steer',
      'task_started',
      'assistant_message_end',
      'turn_cancelled',
    ]),
    terminalStatus: z.optional(z.enum(['completed', 'failed'])),
    connectedServiceSelectionsEnvRaw: z.optional(z.string().check(z.minLength(1), z.maxLength(64 * 1024))),
    requestedAction: z.optional(PendingRequestedActionV1Schema),
    activeTurnId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512)))),
  }));

export type ConnectedServiceTurnLifecycleRequestBody =
  z.infer<
    typeof ConnectedServiceTurnLifecycleRequestBodySchema
  >;

export const ConnectedServiceTurnLifecycleResultSchema =
  lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('continue'),
      turnCustody: TrackedSessionTurnLifecycleResultSchema,
    }),
    z.strictObject({
      status: z.literal('input_blocked'),
      reason: z.literal('request_auth_source_cutover'),
    }),
  ]));

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
