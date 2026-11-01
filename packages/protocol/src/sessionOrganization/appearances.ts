import { z } from 'zod';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';
import { SessionOrganizationContentEnvelopeSchema } from './content.js';
import { lazySchema } from '../lazySchema.js';

const SessionOrganizationSessionIdSchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));

export const SessionOrganizationSessionAppearanceSchema = lazySchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    display: SessionOrganizationContentEnvelopeSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionOrganizationSessionAppearance = z.infer<typeof SessionOrganizationSessionAppearanceSchema>;

export const SetSessionAppearanceRequestSchema = lazySchema(() => z
  .object({
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
  })
  .strict());
export type SetSessionAppearanceRequest = z.infer<typeof SetSessionAppearanceRequestSchema>;

export const SetSessionAppearanceResponseSchema = lazySchema(() => z
  .object({
    appearance: SessionOrganizationSessionAppearanceSchema.nullable(),
  })
  .strict());
export type SetSessionAppearanceResponse = z.infer<typeof SetSessionAppearanceResponseSchema>;
