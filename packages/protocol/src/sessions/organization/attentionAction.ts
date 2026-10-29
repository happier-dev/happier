export { SESSION_ATTENTION_SET_ACTION_ID } from './attentionActionIdsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';
import {
  SetSessionAttentionStandingResponseSchema,
  type SetSessionAttentionStandingRequest,
} from './standings.js';

/** The existing route (`registerSessionOrganizationRoutes.ts`); `:sessionId` is the path parameter. */
export const SESSION_ATTENTION_STANDING_HTTP_PATH_V1 = '/v2/session-organization/attention-standings/:sessionId';

/**
 * The route body plus the exact Session. Exactly one of `standing` / `remindAt` is required; the
 * executor refuses anything else before the port runs, matching the route's own refinement.
 */
export const SessionAttentionSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)),
  standing: z.optional(z.nullable(z.boolean())),
  remindAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
}));
export type SessionAttentionSetInputV1 = z.infer<typeof SessionAttentionSetInputV1Schema>;

export const SessionAttentionSetResultV1Schema = SetSessionAttentionStandingResponseSchema;
export type SessionAttentionSetResultV1 = z.infer<typeof SessionAttentionSetResultV1Schema>;

/** The route body for one parsed Action input, or null when it does not change exactly one field. */
export function resolveSessionAttentionStandingRequest(
  input: SessionAttentionSetInputV1,
): SetSessionAttentionStandingRequest | null {
  const hasStanding = input.standing !== undefined;
  const hasRemindAt = input.remindAt !== undefined;
  if (hasStanding === hasRemindAt) return null;
  return hasStanding ? { standing: input.standing } : { remindAt: input.remindAt };
}

export function buildSessionAttentionStandingHttpPath(sessionId: string): string {
  return SESSION_ATTENTION_STANDING_HTTP_PATH_V1.replace(':sessionId', encodeURIComponent(sessionId));
}
