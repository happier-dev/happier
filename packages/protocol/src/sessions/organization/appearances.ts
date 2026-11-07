import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from './constants.js';
import { SessionOrganizationContentEnvelopeSchema, SessionOrganizationDisplayStateSchema } from './contentSchemas.js';
import { normalizeOpaqueThemeHexColor } from '../../account/settings/themeProfileColors.js';

const SessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));

/** Named theme accents are also persisted personal appearance choices. */
export const SESSION_APPEARANCE_ACCENT_COLOR_KEYS = ['blue', 'green', 'orange', 'yellow', 'red', 'indigo', 'purple'] as const;
export const SessionAppearanceColorSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accent'), key: z.enum(SESSION_APPEARANCE_ACCENT_COLOR_KEYS) }),
  z.strictObject({ kind: z.literal('custom'), hex: z.pipe(z.string().check(z.refine(value => normalizeOpaqueThemeHexColor(value) !== null)),
    z.transform(value => normalizeOpaqueThemeHexColor(value)!)) }),
]));
export type SessionAppearanceColor = z.infer<typeof SessionAppearanceColorSchema>;

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
