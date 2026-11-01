import { z } from 'zod';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';
import { lazySchema } from '../lazySchema.js';

const SessionOrganizationSessionIdSchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));

export const SessionAttentionStandingSchema = lazySchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    standing: z.boolean(),
    remindAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionAttentionStanding = z.infer<typeof SessionAttentionStandingSchema>;

export const SetSessionAttentionStandingRequestSchema = lazySchema(() => z
  .object({
    standing: z.boolean().nullable().optional(),
    remindAt: z.number().int().nonnegative().nullable().optional(),
  })
  .refine((value) => (value.standing === undefined) !== (value.remindAt === undefined), {
    message: 'Change exactly one attention field',
  })
  .strict());
export type SetSessionAttentionStandingRequest = z.infer<typeof SetSessionAttentionStandingRequestSchema>;

export const SetSessionAttentionStandingResponseSchema = lazySchema(() => z
  .object({
    standing: SessionAttentionStandingSchema.nullable(),
  })
  .strict());
export type SetSessionAttentionStandingResponse = z.infer<typeof SetSessionAttentionStandingResponseSchema>;
