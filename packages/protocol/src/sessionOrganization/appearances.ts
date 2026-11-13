import { z } from 'zod';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';
import { SESSION_ORGANIZATION_MAX_SESSION_APPEARANCES } from './constants.js';
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

/**
 * Placement and identity live in a protected carrier so legacy clients that replace or clear the
 * color display cannot erase them. The payload stays opaque to the server in both storage modes.
 */
export const SessionOrganizationSessionAppearancePresentationSchema = lazySchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    presentation: SessionOrganizationContentEnvelopeSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionOrganizationSessionAppearancePresentation = z.infer<typeof SessionOrganizationSessionAppearancePresentationSchema>;

export const SetSessionAppearancePresentationRequestSchema = lazySchema(() => z
  .object({
    presentation: SessionOrganizationContentEnvelopeSchema.nullable(),
  })
  .strict());
export type SetSessionAppearancePresentationRequest = z.infer<typeof SetSessionAppearancePresentationRequestSchema>;

export const SetSessionAppearancePresentationResponseSchema = lazySchema(() => z
  .object({
    presentation: SessionOrganizationSessionAppearancePresentationSchema.nullable(),
  })
  .strict());
export type SetSessionAppearancePresentationResponse = z.infer<typeof SetSessionAppearancePresentationResponseSchema>;

export const SessionAppearancePresentationListResponseSchema = lazySchema(() => z
  .object({
    presentations: z.array(SessionOrganizationSessionAppearancePresentationSchema)
      .max(SESSION_ORGANIZATION_MAX_SESSION_APPEARANCES),
  })
  .strict());
export type SessionAppearancePresentationListResponse = z.infer<typeof SessionAppearancePresentationListResponseSchema>;
