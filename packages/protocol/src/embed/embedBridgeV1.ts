import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AccountApiTokenSummaryV1Schema } from '../auth/accountApiTokens.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { BOX_BUNDLE_MIN_BYTES, BOX_BUNDLE_PUBLIC_KEY_BYTES } from '../crypto/boxBundleFormat.js';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE } from '../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { SessionIdSchema as CanonicalSessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import {
  FrameBridgeEnvelopeBaseV1Schema,
  FrameBridgeHostToFrameEnvelopeBaseV1Schema,
  FrameBridgeIdentityV1Schema,
  FrameBridgeResponseEnvelopeBaseV1Schema,
} from '../frameBridge/frameBridgeEnvelopeV1.js';
import { EmbedStyleV1Schema } from './embedStyleV1.js';

function isCanonicalBase64Url(value: string, acceptsLength: (length: number) => boolean): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return false;
  const bytes = decodeBase64(value, 'base64url');
  return acceptsLength(bytes.length) && encodeBase64(bytes, 'base64url') === value;
}

export const EmbedPublicKeyV1Schema = lazyZodSchema(() => z.string().refine(
  (value) => isCanonicalBase64Url(value, (length) => length === BOX_BUNDLE_PUBLIC_KEY_BYTES),
  'Expected canonical base64url of a 32-byte public key',
));
export const EmbedSessionKeyV1Schema = lazyZodSchema(() => SessionDataKeyEnvelopeBytesV1Schema.refine(
  (value) => decodeBase64(value)[0] === ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE,
  'Unsupported session data-key envelope version',
));
export const EmbedSealedSessionOptionsV1Schema = lazyZodSchema(() => z.string().refine(
  (value) => isCanonicalBase64Url(value, (length) => length >= BOX_BUNDLE_MIN_BYTES),
  'Expected canonical base64url of a sealed box bundle',
));
const SessionIdSchema = asProtocolZod(CanonicalSessionIdSchema);

export const EmbedErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'origin_not_allowed', 'credential_unavailable', 'credential_rejected',
  'session_not_found', 'session_key_unavailable', 'session_key_invalid',
  'session_key_not_transferable', 'unsupported_bridge_version', 'create_not_granted',
]));
export type EmbedErrorCodeV1 = z.infer<typeof EmbedErrorCodeV1Schema>;

export const EmbedUiOverridesV1Schema = lazyZodSchema(() => z.object({
  attachments: z.boolean().optional(),
  modelPicker: z.boolean().optional(),
}).strict());
export type EmbedUiOverridesV1 = z.infer<typeof EmbedUiOverridesV1Schema>;

export const EmbedCredentialV1Schema = lazyZodSchema(() => z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  sessionKey: EmbedSessionKeyV1Schema.optional(),
  sessionOptions: EmbedSealedSessionOptionsV1Schema.optional(),
}).strict());
export type EmbedCredentialV1 = z.infer<typeof EmbedCredentialV1Schema>;

/** SDK issuance includes a non-secret id; it is not part of the frame wire credential. */
export const EmbedIssuedCredentialV1Schema = lazyZodSchema(() => EmbedCredentialV1Schema.extend({
  tokenId: AccountApiTokenSummaryV1Schema.shape.tokenId,
}).strict());
export type EmbedIssuedCredentialV1 = z.infer<typeof EmbedIssuedCredentialV1Schema>;
export const EmbedCredentialInputV1Schema = lazyZodSchema(() => z.union([EmbedCredentialV1Schema, EmbedIssuedCredentialV1Schema]));
export type EmbedCredentialInputV1 = z.infer<typeof EmbedCredentialInputV1Schema>;

/** Parse an exact supported input before removing only the validated issuance id. */
export function projectEmbedCredentialV1(value: unknown): EmbedCredentialV1 {
  const parsed = EmbedCredentialInputV1Schema.parse(value);
  return {
    token: parsed.token,
    expiresAt: parsed.expiresAt,
    ...(parsed.sessionKey === undefined ? {} : { sessionKey: parsed.sessionKey }),
    ...(parsed.sessionOptions === undefined ? {} : { sessionOptions: parsed.sessionOptions }),
  };
}

export const EmbedReadyV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('ready'),
  bridgeVersion: z.literal(1),
  identity: FrameBridgeIdentityV1Schema,
  embedPublicKey: EmbedPublicKeyV1Schema,
}).strict());
export type EmbedReadyV1 = z.infer<typeof EmbedReadyV1Schema>;

export const EmbedInitV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('init'),
  identity: FrameBridgeIdentityV1Schema,
  sessionId: SessionIdSchema.optional(),
  credential: EmbedCredentialV1Schema,
  ui: EmbedUiOverridesV1Schema.optional(),
  style: EmbedStyleV1Schema.optional(),
}).strict());
export type EmbedInitV1 = z.infer<typeof EmbedInitV1Schema>;

export const EmbedCredentialRequestV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('credential.request'),
  sessionId: SessionIdSchema.optional(),
  embedPublicKey: EmbedPublicKeyV1Schema,
  reason: z.enum(['initial', 'expiring', 'rejected', 'open', 'created']),
  createdByTokenId: AccountApiTokenSummaryV1Schema.shape.tokenId.optional(),
}).strict().superRefine((value, context) => {
  if (value.reason === 'created') {
    if (value.createdByTokenId === undefined) context.addIssue({ code: 'custom', path: ['createdByTokenId'], message: 'Created-session requests require credential attribution.' });
    if (value.sessionId === undefined) context.addIssue({ code: 'custom', path: ['sessionId'], message: 'Created-session requests require a session id.' });
  } else if (value.createdByTokenId !== undefined) {
    context.addIssue({ code: 'custom', path: ['createdByTokenId'], message: 'Only created-session requests carry credential attribution.' });
  }
}));
export type EmbedCredentialRequestV1 = z.infer<typeof EmbedCredentialRequestV1Schema>;

export const EmbedConfigureV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('configure'),
  ui: EmbedUiOverridesV1Schema.optional(),
  style: EmbedStyleV1Schema.optional(),
}).strict());
export type EmbedConfigureV1 = z.infer<typeof EmbedConfigureV1Schema>;

export const EmbedOpenV1Schema = lazyZodSchema(() => z.object({ kind: z.literal('open'), sessionId: SessionIdSchema.nullable() }).strict());
export type EmbedOpenV1 = z.infer<typeof EmbedOpenV1Schema>;
export const EmbedSessionCreatedV1Schema = lazyZodSchema(() => z.object({ kind: z.literal('session.created'), sessionId: SessionIdSchema }).strict());
export type EmbedSessionCreatedV1 = z.infer<typeof EmbedSessionCreatedV1Schema>;
export const EmbedStateV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('state'),
  sessionId: SessionIdSchema.nullable(),
  phase: z.enum(['loading', 'ready', 'error']),
  activity: z.enum(['idle', 'working', 'needs_attention']).optional(),
  error: EmbedErrorCodeV1Schema.optional(),
}).strict());
export type EmbedStateV1 = z.infer<typeof EmbedStateV1Schema>;

export const EmbedHostToFrameEnvelopeV1Schema = lazyZodSchema(() => FrameBridgeHostToFrameEnvelopeBaseV1Schema.extend({
  payload: z.discriminatedUnion('kind', [EmbedInitV1Schema, EmbedConfigureV1Schema, EmbedOpenV1Schema]),
}).strict());
export type EmbedHostToFrameEnvelopeV1 = z.infer<typeof EmbedHostToFrameEnvelopeV1Schema>;
export const EmbedFrameToHostEnvelopeV1Schema = lazyZodSchema(() => FrameBridgeEnvelopeBaseV1Schema.extend({
  payload: z.union([EmbedCredentialRequestV1Schema, EmbedSessionCreatedV1Schema, EmbedStateV1Schema]),
}).strict());
export type EmbedFrameToHostEnvelopeV1 = z.infer<typeof EmbedFrameToHostEnvelopeV1Schema>;
export const EmbedCredentialResultEnvelopeV1Schema = lazyZodSchema(() => FrameBridgeResponseEnvelopeBaseV1Schema.extend({
  kind: z.literal('result'), payload: EmbedCredentialV1Schema,
}).strict());
export type EmbedCredentialResultEnvelopeV1 = z.infer<typeof EmbedCredentialResultEnvelopeV1Schema>;
export const EmbedCredentialErrorEnvelopeV1Schema = lazyZodSchema(() => FrameBridgeResponseEnvelopeBaseV1Schema.extend({
  kind: z.literal('error'), payload: z.object({ code: EmbedErrorCodeV1Schema }).strict(),
}).strict());
export type EmbedCredentialErrorEnvelopeV1 = z.infer<typeof EmbedCredentialErrorEnvelopeV1Schema>;
