import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';
import {
  SetSessionAttentionStandingResponseSchema,
  type SetSessionAttentionStandingRequest,
} from './standings.js';

/**
 * `session.attention.set` (ORC R-10): the one Action over the existing attention-standing route.
 *
 * Settle is `{ standing: false }` (paired with `session.read_state.set`), snooze is `{ remindAt }`,
 * and a null clears that field. It adds no storage and no second writer: the server's
 * standing route stays the only persistence owner, and this Action only names it.
 */
export const SESSION_ATTENTION_SET_ACTION_ID = 'session.attention.set' as const;

/** The existing route (`registerSessionOrganizationRoutes.ts`); `:sessionId` is the path parameter. */
export const SESSION_ATTENTION_STANDING_HTTP_PATH_V1 = '/v2/session-organization/attention-standings/:sessionId';

/**
 * The route body plus the exact Session. Exactly one of `standing` / `remindAt` is required; the
 * executor refuses anything else before the port runs, matching the route's own refinement.
 */
export const SessionAttentionSetInputV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH),
  standing: z.boolean().nullable().optional(),
  remindAt: z.number().int().nonnegative().nullable().optional(),
}).strict());
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
