import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';

const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));

export const SessionAttentionStandingSchema = lazyZodSchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    standing: z.boolean(),
    remindAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionAttentionStanding = z.infer<typeof SessionAttentionStandingSchema>;

export const SetSessionAttentionStandingRequestSchema = lazyZodSchema(() => z
  .object({
    standing: z.boolean().nullable().optional(),
    remindAt: z.number().int().nonnegative().nullable().optional(),
  })
  .refine((value) => (value.standing === undefined) !== (value.remindAt === undefined), { message: 'Change exactly one attention field' })
  .strict());
export type SetSessionAttentionStandingRequest = z.infer<typeof SetSessionAttentionStandingRequestSchema>;

export const SetSessionAttentionStandingResponseSchema = lazyZodSchema(() => z
  .object({
    standing: SessionAttentionStandingSchema.nullable(),
  })
  .strict());
export type SetSessionAttentionStandingResponse = z.infer<typeof SetSessionAttentionStandingResponseSchema>;
