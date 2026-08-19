import { z } from 'zod';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';

const SessionOrganizationSessionIdSchema = z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH);

export const SessionAttentionStandingSchema = z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    standing: z.boolean(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type SessionAttentionStanding = z.infer<typeof SessionAttentionStandingSchema>;

export const SetSessionAttentionStandingRequestSchema = z
  .object({
    standing: z.boolean().nullable(),
  })
  .strict();
export type SetSessionAttentionStandingRequest = z.infer<typeof SetSessionAttentionStandingRequestSchema>;

export const SetSessionAttentionStandingResponseSchema = z
  .object({
    standing: SessionAttentionStandingSchema.nullable(),
  })
  .strict();
export type SetSessionAttentionStandingResponse = z.infer<typeof SetSessionAttentionStandingResponseSchema>;
