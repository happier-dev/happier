import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
  ExternalActionTargetV1Schema,
  type ExternalActionTargetV1,
} from './externalActionApi.js';

/**
 * Strict host-to-daemon Action request wrapper for transport-owned routing
 * facts. `input` remains the complete semantic Action input; target metadata
 * is opened only by the generic RPC ingress and is never passed to an Action
 * input schema.
 */
export const TargetedActionRpcRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('targeted_action_rpc'),
  input: z.unknown(),
  target: ExternalActionTargetV1Schema,
  /** The caller's invoking Session (host context `defaultSessionId`), e.g. a Run's origin. */
  defaultSessionId: z.string().trim().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'input')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['input'],
      message: 'input is required',
    });
  }
}));

export type TargetedActionRpcRequestV1 = z.infer<typeof TargetedActionRpcRequestV1Schema>;

export function createTargetedActionRpcRequestV1(
  input: unknown,
  target: ExternalActionTargetV1,
  context: Readonly<{ defaultSessionId?: string | null }> = {},
): TargetedActionRpcRequestV1 {
  return TargetedActionRpcRequestV1Schema.parse({
    v: 1,
    kind: 'targeted_action_rpc',
    input,
    target,
    ...(context.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
  });
}
