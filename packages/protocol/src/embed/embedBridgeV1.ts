import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

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

export const EmbedPublicKeyV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => isCanonicalBase64Url(value, (length) => length === BOX_BUNDLE_PUBLIC_KEY_BYTES), 'Expected canonical base64url of a 32-byte public key')));
export const EmbedSessionKeyV1Schema = lazyZodSchema(() => SessionDataKeyEnvelopeBytesV1Schema.check(zMini.refine((value) => decodeBase64(value)[0] === ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE, 'Unsupported session data-key envelope version')));
export const EmbedSealedSessionOptionsV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => isCanonicalBase64Url(value, (length) => length >= BOX_BUNDLE_MIN_BYTES), 'Expected canonical base64url of a sealed box bundle')));
const SessionIdSchema = asProtocolZod(CanonicalSessionIdSchema);

export const EmbedErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'origin_not_allowed', 'credential_unavailable', 'credential_rejected',
  'session_not_found', 'session_key_unavailable', 'session_key_invalid',
  'session_key_not_transferable', 'unsupported_bridge_version', 'create_not_granted',
]));
export type EmbedErrorCodeV1 = z.infer<typeof EmbedErrorCodeV1Schema>;

export const EmbedUiOverridesV1Schema = lazyZodSchema(() => z.strictObject({
  attachments: z.optional(z.boolean()),
  modelPicker: z.optional(z.boolean()),
}));
export type EmbedUiOverridesV1 = z.infer<typeof EmbedUiOverridesV1Schema>;

export const EmbedCredentialV1Schema = lazyZodSchema(() => z.strictObject({
  token: z.string().check(z.minLength(1)),
  expiresAt: z.string().check(z.iso.datetime({ offset: true })),
  sessionKey: zMini.optional(EmbedSessionKeyV1Schema),
  sessionOptions: z.optional(EmbedSealedSessionOptionsV1Schema),
}));
export type EmbedCredentialV1 = z.infer<typeof EmbedCredentialV1Schema>;

/** SDK issuance includes a non-secret id; it is not part of the frame wire credential. */
export const EmbedIssuedCredentialV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EmbedCredentialV1Schema, {
  tokenId: AccountApiTokenSummaryV1Schema.shape.tokenId,
})));
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

export const EmbedReadyV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('ready'),
  bridgeVersion: z.literal(1),
  identity: FrameBridgeIdentityV1Schema,
  embedPublicKey: EmbedPublicKeyV1Schema,
}));
export type EmbedReadyV1 = z.infer<typeof EmbedReadyV1Schema>;

export const EmbedInitV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('init'),
  identity: FrameBridgeIdentityV1Schema,
  sessionId: zMini.optional(SessionIdSchema),
  credential: EmbedCredentialV1Schema,
  ui: z.optional(EmbedUiOverridesV1Schema),
  style: zMini.optional(EmbedStyleV1Schema),
}));
export type EmbedInitV1 = z.infer<typeof EmbedInitV1Schema>;

export const EmbedCredentialRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('credential.request'),
  sessionId: zMini.optional(SessionIdSchema),
  embedPublicKey: EmbedPublicKeyV1Schema,
  reason: z.enum(['initial', 'expiring', 'rejected', 'open', 'created']),
  createdByTokenId: zMini.optional(AccountApiTokenSummaryV1Schema.shape.tokenId),
}).check(z.superRefine((value, context) => {
  if (value.reason === 'created') {
    if (value.createdByTokenId === undefined) context.addIssue({ code: 'custom', path: ['createdByTokenId'], message: 'Created-session requests require credential attribution.' });
    if (value.sessionId === undefined) context.addIssue({ code: 'custom', path: ['sessionId'], message: 'Created-session requests require a session id.' });
  } else if (value.createdByTokenId !== undefined) {
    context.addIssue({ code: 'custom', path: ['createdByTokenId'], message: 'Only created-session requests carry credential attribution.' });
  }
})));
export type EmbedCredentialRequestV1 = z.infer<typeof EmbedCredentialRequestV1Schema>;

export const EmbedConfigureV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('configure'),
  ui: z.optional(EmbedUiOverridesV1Schema),
  style: zMini.optional(EmbedStyleV1Schema),
}));
export type EmbedConfigureV1 = z.infer<typeof EmbedConfigureV1Schema>;

export const EmbedOpenV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('open'), sessionId: zMini.nullable(SessionIdSchema) }));
export type EmbedOpenV1 = z.infer<typeof EmbedOpenV1Schema>;
export const EmbedSessionCreatedV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('session.created'), sessionId: SessionIdSchema }));
export type EmbedSessionCreatedV1 = z.infer<typeof EmbedSessionCreatedV1Schema>;
export const EmbedStateV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('state'),
  sessionId: zMini.nullable(SessionIdSchema),
  phase: z.enum(['loading', 'ready', 'error']),
  activity: z.optional(z.enum(['idle', 'working', 'needs_attention'])),
  error: z.optional(EmbedErrorCodeV1Schema),
}));
export type EmbedStateV1 = z.infer<typeof EmbedStateV1Schema>;

export const EmbedHostToFrameEnvelopeV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(FrameBridgeHostToFrameEnvelopeBaseV1Schema, {
  payload: z.discriminatedUnion('kind', [EmbedInitV1Schema, EmbedConfigureV1Schema, EmbedOpenV1Schema]),
})));
export type EmbedHostToFrameEnvelopeV1 = z.infer<typeof EmbedHostToFrameEnvelopeV1Schema>;
export const EmbedFrameToHostEnvelopeV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(FrameBridgeEnvelopeBaseV1Schema, {
  payload: z.union([EmbedCredentialRequestV1Schema, EmbedSessionCreatedV1Schema, EmbedStateV1Schema]),
})));
export type EmbedFrameToHostEnvelopeV1 = z.infer<typeof EmbedFrameToHostEnvelopeV1Schema>;
export const EmbedCredentialResultEnvelopeV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(FrameBridgeResponseEnvelopeBaseV1Schema, {
  kind: z.literal('result'), payload: EmbedCredentialV1Schema,
})));
export type EmbedCredentialResultEnvelopeV1 = z.infer<typeof EmbedCredentialResultEnvelopeV1Schema>;
export const EmbedCredentialErrorEnvelopeV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(FrameBridgeResponseEnvelopeBaseV1Schema, {
  kind: z.literal('error'), payload: z.strictObject({ code: EmbedErrorCodeV1Schema }),
})));
export type EmbedCredentialErrorEnvelopeV1 = z.infer<typeof EmbedCredentialErrorEnvelopeV1Schema>;
