import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { AttentionRemindAtV1Schema } from '../../activity/attentionReminderV1.js';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';

const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));

export const SessionAttentionStandingSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    standing: z.boolean(),
    remindAt: z.optional(AttentionRemindAtV1Schema),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionAttentionStanding = z.infer<typeof SessionAttentionStandingSchema>;

export const SetSessionAttentionStandingRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z
  .object({
    standing: z.optional(z.nullable(z.boolean())),
    remindAt: z.optional(z.nullable(AttentionRemindAtV1Schema)),
  }).check(z.refine((value) => (value.standing === undefined) !== (value.remindAt === undefined), { message: 'Change exactly one attention field' }))));
export type SetSessionAttentionStandingRequest = z.infer<typeof SetSessionAttentionStandingRequestSchema>;

export const SetSessionAttentionStandingResponseSchema = lazyZodSchema(() => z.strictObject({
    standing: z.nullable(SessionAttentionStandingSchema),
  }));
export type SetSessionAttentionStandingResponse = z.infer<typeof SetSessionAttentionStandingResponseSchema>;
