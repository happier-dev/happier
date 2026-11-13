import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PrincipalRefV1Schema } from '../../teams/principal.js';
import { SessionAccessLevelV1Schema, SessionGrantIntentV1Schema } from './sessionAccessGrantV1.js';
import { RequiredSessionTeamCredentialV1Schema, SessionAccessGrantsListRequestV1Schema } from './sessionAccessOperationsV1.js';
import { buildStoredContentPublicShareUrlV1 } from '../../sharing/storedContentPublicShareV1.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionDataKeyEnvelopeRecipientAccountIdV1Schema, SessionDataKeyEnvelopeSummaryV1Schema, SessionDataKeyRecipientUnavailableReasonV1Schema } from '../encryption/sessionDataKeyEnvelopes.js';

/** Logical client intents; no caller-supplied key, envelope or metadata payload. */
export const SessionAccessEncryptionPrepareInputV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: asProtocolZod<string, string>(SessionIdSchema) }));
export const SessionAccessEncryptionReprepareInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod<string, string>(SessionIdSchema), recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
}));
export const SessionAccessEncryptionPrepareResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['complete', 'incomplete', 'scope_changed', 'not_required', 'session_data_key_unavailable']),
  preparedCount: z.number().check(z.int(), z.nonnegative()),
  skippedCount: z.number().check(z.int(), z.nonnegative()),
  summary: z.nullable(SessionDataKeyEnvelopeSummaryV1Schema),
  recipientsNeedingSetup: z.array(z.strictObject({
    recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
    reason: SessionDataKeyRecipientUnavailableReasonV1Schema,
  })),
  invalidBindingRecipients: z.array(SessionDataKeyEnvelopeRecipientAccountIdV1Schema),
}));
export const SessionAccessLayoutUpdateResultV1Schema = lazyZodSchema(() => z.strictObject({ status: z.literal('complete') }));

/** Public logical input: recipient envelopes are materialized by the host crypto owner. */
export const SessionAccessGrantSetActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionAccessGrantsListRequestV1Schema.shape,
  subject: PrincipalRefV1Schema,
  accessLevel: SessionAccessLevelV1Schema,
  canApprovePermissions: z.boolean(),
  requiredTeamCredential: z.optional(RequiredSessionTeamCredentialV1Schema),
}).check(z.superRefine(({ sessionId: _sessionId, requiredTeamCredential: _requiredTeamCredential, ...grant }, context) => {
  const parsed = SessionGrantIntentV1Schema.safeParse(grant);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
})));

export const SessionPublicLinkCreateActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionAccessGrantsListRequestV1Schema.shape,
  expiresAt: z.optional(z.number()),
  maxUses: z.optional(z.number().check(z.int(), z.positive())),
  isConsentRequired: z.optional(z.boolean()),
  networkOff: z.optional(z.boolean()),
}));

/**
 * Publication reads contain settings only. Creation adds the complete URL
 * only when it was not privately delivered; the wrapped key stays HTTP-only.
 *
 * `id` and `updatedAt` are publication metadata, not bearer identity. Public
 * reads can mutate `updatedAt`, and token rotation keeps the row `id`, so
 * neither field individually authenticates device-held bearer material. A UI
 * may retain its local bearer across a field-for-field identical settings
 * refresh as a continuity heuristic; the server remains the bearer authority.
 * Ambiguous create/rotate settlement belongs to the physical request
 * executor's exact value-idempotent replay.
 */
export const SessionPublicLinkSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  expiresAt: z.nullable(z.number()),
  maxUses: z.nullable(z.number().check(z.int(), z.positive())),
  useCount: z.number().check(z.int(), z.nonnegative()),
  isConsentRequired: z.boolean(),
  networkOff: z.optional(z.boolean()),
  updatedAt: z.number(),
  keyDerivation: z.optional(z.enum(['fragment_v1', 'legacy_token_v1'])),
  viewerOrigin: z.optional(z.string().check(z.url())),
}));
export type SessionPublicLinkSettingsV1 = z.infer<typeof SessionPublicLinkSettingsV1Schema>;
export const SessionPublicLinkGetActionResultV1Schema = lazyZodSchema(() => z.nullable(SessionPublicLinkSettingsV1Schema));
export const SessionPublicLinkCreateActionResultV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPublicLinkSettingsV1Schema, { url: z.optional(z.string().check(z.url())) })));
export const SessionPublicLinkRemoveActionResultV1Schema = lazyZodSchema(() => z.strictObject({ changed: z.boolean() }));

/** The released owner route is additive; project only explicitly public settings. */
export function projectSessionPublicLinkActionResultV1(value: unknown): SessionPublicLinkSettingsV1 | null {
  const response = z.looseObject({
    publicShare: lazyZodSchema(() => z.nullable((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(SessionPublicLinkSettingsV1Schema))),
    viewerOrigin: z.optional(z.string().check(z.url())),
  }).parse(value);
  if (response.publicShare === null) return null;
  const { id, expiresAt, maxUses, useCount, isConsentRequired, networkOff, updatedAt, keyDerivation } = response.publicShare;
  return { id, expiresAt, maxUses, useCount, isConsentRequired, updatedAt,
    ...(networkOff !== undefined ? { networkOff } : {}),
    ...(keyDerivation ? { keyDerivation } : {}),
    ...(response.viewerOrigin ? { viewerOrigin: response.viewerOrigin } : {}),
  };
}

/** Project host-held material only when the caller still needs direct delivery. */
export function projectSessionPublicLinkCreateActionResultV1(
  value: unknown,
  material: Readonly<{ lookupId: string; secret: string }>,
  networkOff: boolean,
  privatelyDelivered = false,
): z.infer<typeof SessionPublicLinkCreateActionResultV1Schema> {
  const settings = projectSessionPublicLinkActionResultV1(value);
  if (!settings || !settings.viewerOrigin || settings.keyDerivation !== 'fragment_v1'
    || (networkOff && settings.networkOff !== true)) throw new Error('public_link_publication_unconfirmed');
  return SessionPublicLinkCreateActionResultV1Schema.parse({ ...settings,
    ...(privatelyDelivered ? {} : { url: buildStoredContentPublicShareUrlV1({ origin: settings.viewerOrigin, ...material }) }) });
}
