import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PrincipalRefV1Schema } from '../../teams/principal.js';
import { SessionAccessLevelV1Schema, SessionGrantIntentV1Schema } from './sessionAccessGrantV1.js';
import { RequiredSessionTeamCredentialV1Schema, SessionAccessGrantsListRequestV1Schema } from './sessionAccessOperationsV1.js';
import { buildStoredContentPublicShareUrlV1 } from '../../sharing/storedContentPublicShareV1.js';

/** Public logical input: recipient envelopes are materialized by the host crypto owner. */
export const SessionAccessGrantSetActionInputV1Schema = lazyZodSchema(() => z.object({
  ...SessionAccessGrantsListRequestV1Schema.shape,
  subject: PrincipalRefV1Schema,
  accessLevel: SessionAccessLevelV1Schema,
  canApprovePermissions: z.boolean(),
  requiredTeamCredential: RequiredSessionTeamCredentialV1Schema.optional(),
}).strict().superRefine(({ sessionId: _sessionId, requiredTeamCredential: _requiredTeamCredential, ...grant }, context) => {
  const parsed = SessionGrantIntentV1Schema.safeParse(grant);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
}));

export const SessionPublicLinkCreateActionInputV1Schema = lazyZodSchema(() => z.object({
  ...SessionAccessGrantsListRequestV1Schema.shape,
  expiresAt: z.number().optional(),
  maxUses: z.number().int().positive().optional(),
  isConsentRequired: z.boolean().optional(),
  networkOff: z.boolean().optional(),
}).strict());

/**
 * Publication reads contain settings only. Approved creation adds the complete
 * URL for its caller; the wrapped key remains an HTTP-only field.
 *
 * `id` and `updatedAt` are publication metadata, not bearer identity. Public
 * reads can mutate `updatedAt`, and token rotation keeps the row `id`, so
 * neither field individually authenticates device-held bearer material. A UI
 * may retain its local bearer across a field-for-field identical settings
 * refresh as a continuity heuristic; the server remains the bearer authority.
 * Ambiguous create/rotate settlement belongs to the physical request
 * executor's exact value-idempotent replay.
 */
export const SessionPublicLinkSettingsV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  expiresAt: z.number().nullable(),
  maxUses: z.number().int().positive().nullable(),
  useCount: z.number().int().nonnegative(),
  isConsentRequired: z.boolean(),
  networkOff: z.boolean().optional(),
  updatedAt: z.number(),
  keyDerivation: z.enum(['fragment_v1', 'legacy_token_v1']).optional(),
  isolatedOrigin: z.string().url().optional(),
}).strict());
export type SessionPublicLinkSettingsV1 = z.infer<typeof SessionPublicLinkSettingsV1Schema>;
export const SessionPublicLinkGetActionResultV1Schema = lazyZodSchema(() => SessionPublicLinkSettingsV1Schema.nullable());
export const SessionPublicLinkCreateActionResultV1Schema = lazyZodSchema(() => SessionPublicLinkSettingsV1Schema.extend({ url: z.string().url() }).strict());
export const SessionPublicLinkRemoveActionResultV1Schema = lazyZodSchema(() => z.object({ changed: z.boolean() }).strict());

/** The released owner route is additive; project only explicitly public settings. */
export function projectSessionPublicLinkActionResultV1(value: unknown): SessionPublicLinkSettingsV1 | null {
  const response = z.object({
    publicShare: SessionPublicLinkSettingsV1Schema.loose().nullable(),
    isolatedOrigin: z.string().url().optional(),
  }).loose().parse(value);
  if (response.publicShare === null) return null;
  const { id, expiresAt, maxUses, useCount, isConsentRequired, networkOff, updatedAt, keyDerivation } = response.publicShare;
  return { id, expiresAt, maxUses, useCount, isConsentRequired, updatedAt,
    ...(networkOff !== undefined ? { networkOff } : {}),
    ...(keyDerivation ? { keyDerivation } : {}),
    ...(response.isolatedOrigin ? { isolatedOrigin: response.isolatedOrigin } : {}),
  };
}

/** Complete approved result built from host-held material, never from server bearer fields. */
export function projectSessionPublicLinkCreateActionResultV1(
  value: unknown,
  material: Readonly<{ lookupId: string; secret: string }>,
): z.infer<typeof SessionPublicLinkCreateActionResultV1Schema> {
  const settings = projectSessionPublicLinkActionResultV1(value);
  if (!settings || !settings.isolatedOrigin || settings.keyDerivation !== 'fragment_v1') throw new Error('public_link_publication_unconfirmed');
  return SessionPublicLinkCreateActionResultV1Schema.parse({ ...settings,
    url: buildStoredContentPublicShareUrlV1({ origin: settings.isolatedOrigin, ...material }) });
}
