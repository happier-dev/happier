import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';
import { SessionOrganizationContentEnvelopeSchema, SessionOrganizationDisplayStateSchema } from './contentSchemas.js';

const SessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));

export const SessionOrganizationSessionAppearanceSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionIdSchema,
  display: z.nullable(SessionOrganizationContentEnvelopeSchema),
  displayState: z.optional(SessionOrganizationDisplayStateSchema),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionOrganizationSessionAppearance = z.infer<typeof SessionOrganizationSessionAppearanceSchema>;

export const SetSessionAppearanceRequestSchema = lazyZodSchema(() => z.strictObject({
  display: z.nullable(SessionOrganizationContentEnvelopeSchema),
}));
export type SetSessionAppearanceRequest = z.infer<typeof SetSessionAppearanceRequestSchema>;

export const SetSessionAppearanceResponseSchema = lazyZodSchema(() => z.strictObject({
  appearance: z.nullable(SessionOrganizationSessionAppearanceSchema),
}));
export type SetSessionAppearanceResponse = z.infer<typeof SetSessionAppearanceResponseSchema>;
