import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { encodeBase64 } from '../crypto/base64.js';
import { SessionStoredMessageContentSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { ArtifactBlobReadResponseV1Schema } from '../artifacts/artifactBinaryV1.js';
import { SessionSystemRecordSchema } from '../sessions/system/records/sessionSystemRecord.js';
import { SessionSystemRecordContentSchema } from '../sessions/system/records/sessionSystemRecordContent.js';
import { SessionTranscriptSurfaceItemReferenceInputV1Schema, SessionTranscriptSurfaceItemReferenceReadV1Schema } from '../sessions/messages/transcriptObservationV1.js';
import { SessionMessageRoleSchema } from '../sessions/messages/sessionMessageRole.js';

/** Closed authority-bearing HTTP objects; no fragment secret is a transport field. */
export const StoredContentPublicShareSubjectV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['session', 'artifact']), id: z.string().check(z.minLength(1)),
}));
export type StoredContentPublicShareSubjectV1 = z.infer<typeof StoredContentPublicShareSubjectV1Schema>;

export const StoredContentPublicShareKeyDerivationV1Schema = lazyZodSchema(() => z.enum(['fragment_v1', 'legacy_token_v1']));
export const StoredContentPublicShareCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  subject: StoredContentPublicShareSubjectV1Schema,
  lookupId: z.string().check(z.minLength(1)),
  encryptedDataKey: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  keyDerivation: z.literal('fragment_v1'),
  expiresAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  maxUses: z.optional(z.number().check(z.int(), z.positive())),
  isConsentRequired: z.optional(z.boolean()),
  networkOff: z.optional(z.boolean()),
}));
export type StoredContentPublicShareCreateRequestV1 = z.infer<typeof StoredContentPublicShareCreateRequestV1Schema>;

export const StoredContentPublicShareV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), subject: StoredContentPublicShareSubjectV1Schema,
  audience: z.optional(z.literal('signed_in')),
  expiresAt: z.nullable(z.number().check(z.int(), z.nonnegative())), maxUses: z.nullable(z.number().check(z.int(), z.positive())),
  useCount: z.number().check(z.int(), z.nonnegative()), isConsentRequired: z.boolean(), networkOff: z._default(z.boolean(), false),
  createdAt: z.number().check(z.int(), z.nonnegative()), updatedAt: z.number().check(z.int(), z.nonnegative()),
  keyDerivation: StoredContentPublicShareKeyDerivationV1Schema,
}));
export type StoredContentPublicShareV1 = z.infer<typeof StoredContentPublicShareV1Schema>;
/** Use limits govern new viewers; expiry or deletion ends the publication itself. */
export function isStoredContentPublicShareActiveV1(publication: Readonly<{ expiresAt: number | null }> | null, nowMs: number): boolean {
  return publication !== null && !(publication.expiresAt !== null && publication.expiresAt <= nowMs);
}
export const StoredContentPublicSharesListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  publicShares: z.array(StoredContentPublicShareV1Schema),
}));
export type StoredContentPublicSharesListResponseV1 = z.infer<typeof StoredContentPublicSharesListResponseV1Schema>;
export const StoredContentPublicShareCreateResponseV1Schema = lazyZodSchema(() => z.strictObject({
  publicShare: StoredContentPublicShareV1Schema,
  viewerOrigin: z.string().check(z.url()),
}));

export const StoredContentPublicShareAccessLogV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), accessedAt: z.number().check(z.int(), z.nonnegative()),
  ipAddress: z.nullable(z.string()), userAgent: z.nullable(z.string()),
}));
export const StoredContentPublicShareAccessLogResponseV1Schema = lazyZodSchema(() => z.strictObject({
  accessLog: z.array(StoredContentPublicShareAccessLogV1Schema),
}));

export const StoredContentPublicShareReadResponseV1Schema = lazyZodSchema(() => z.strictObject({
  subject: StoredContentPublicShareSubjectV1Schema,
  encryptionMode: z.enum(['e2ee', 'plain']),
  encryptedDataKey: z.nullable(z.string().check(z.minLength(1))),
  keyDerivation: StoredContentPublicShareKeyDerivationV1Schema,
  isConsentRequired: z.boolean(),
  networkOff: z._default(z.boolean(), false),
  messagesAccessToken: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  content: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('artifact'), header: z.string(), body: z.string(),
      headerVersion: z.number().check(z.int(), z.positive()), bodyVersion: z.number().check(z.int(), z.positive()),
      blob: z.optional(ArtifactBlobReadResponseV1Schema),
    }),
    z.strictObject({
      kind: z.literal('session'), metadata: z.nullable(z.string()), metadataVersion: z.number().check(z.int(), z.nonnegative()),
      metadataLayoutVersion: z.optional(z.number().check(z.int())), agentState: z.nullable(z.string()),
      agentStateVersion: z.number().check(z.int(), z.nonnegative()), messages: z.array(z.object({
        id: z.string().check(z.minLength(1)), seq: z.number().check(z.int(), z.nonnegative()), localId: z.optional(z.nullable(z.string())),
        createdAt: z.number(), content: SessionStoredMessageContentSchema,
        surfaceItemReference: z.optional(z.nullable(z.lazy(() => SessionTranscriptSurfaceItemReferenceInputV1Schema))),
        messageRole: z.optional(SessionMessageRoleSchema),
      })),
      hasMore: z.boolean(), nextBeforeSeq: z.nullable(z.number().check(z.int(), z.nonnegative())),
    }),
  ]),
}).check(z.superRefine((value, context) => {
  if (value.subject.kind !== value.content.kind) context.addIssue({ code: 'custom', message: 'Public-share subject/content mismatch' });
  if ((value.encryptionMode === 'e2ee') !== (value.encryptedDataKey !== null)) {
    context.addIssue({ code: 'custom', message: 'Public-share mode/key mismatch' });
  }
})));
export type StoredContentPublicShareReadResponseV1 = z.infer<typeof StoredContentPublicShareReadResponseV1Schema>;

/** A message capability is the only public visual selector; item ids are not request authority. */
export const StoredContentPublicShareVisualReadResponseV1Schema = lazyZodSchema(() => z.strictObject({
  messageId: z.string().check(z.minLength(1)),
  encryptionMode: z.enum(['plain', 'e2ee']),
  networkOff: z.boolean(),
  reference: z.lazy(() => SessionTranscriptSurfaceItemReferenceReadV1Schema),
  record: z.extend(SessionSystemRecordSchema, { content: SessionSystemRecordContentSchema }),
}).check(z.superRefine((value, context) => {
  if ((value.encryptionMode === 'plain') !== (value.record.content.t === 'plain')
    || value.record.address.owner !== 'host' || value.record.address.namespace !== 'surface'
    || value.record.address.kind !== 'item.v1' || value.record.address.localId !== value.reference.itemId) {
    context.addIssue({ code: 'custom', message: 'Public visual mode or addressed identity mismatch' });
  }
})));
export type StoredContentPublicShareVisualReadResponseV1 = z.infer<typeof StoredContentPublicShareVisualReadResponseV1Schema>;

/** Independent cryptographic capabilities: the lookup is HTTP-visible, the secret is local. */
export function generateStoredContentPublicShareMaterialV1(randomBytes: (length: number) => Uint8Array): Readonly<{ lookupId: string; secret: string }> {
  const lookup = randomBytes(32);
  const secret = randomBytes(32);
  if (lookup.byteLength !== 32 || secret.byteLength !== 32) throw new Error('Public-share material requires 32 random bytes');
  return { lookupId: encodeBase64(lookup, 'base64url'), secret: encodeBase64(secret, 'base64url') };
}

/** Hosts supply their existing shareable Home URL projection; construction preserves UI prefixes. */
export function buildPublicShareApplicationUrlV1(params: Readonly<{
  applicationBaseUrl: string; token: string; serverUrl?: string | null; kind?: 'artifact';
}>): string {
  const base = params.applicationBaseUrl.replace(/\/+$/, '');
  const path = `${base}/share/${params.kind === 'artifact' ? 'artifact/' : ''}${encodeURIComponent(params.token)}`;
  return params.serverUrl ? `${path}?${new URLSearchParams({ server: params.serverUrl }).toString()}` : path;
}

export function buildStoredContentPublicShareUrlV1(params: Readonly<{
  origin: string; lookupId: string; secret: string; audience?: 'signed_in'; shareableServerUrl?: string | null;
}>): string {
  const origin = new URL(params.origin);
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw new Error('Invalid public-share origin');
  if (origin.username || origin.password || (params.audience !== 'signed_in' && origin.pathname !== '/') || origin.search || origin.hash) throw new Error('Invalid public-share origin');
  if (!params.lookupId || !params.secret) throw new Error('Public-share material is required');
  const url = params.audience === 'signed_in' ? buildPublicShareApplicationUrlV1({ applicationBaseUrl: origin.toString(),
    token: params.lookupId, kind: 'artifact', serverUrl: params.shareableServerUrl }) : `${origin.origin}/s/${encodeURIComponent(params.lookupId)}`;
  return `${url}#${new URLSearchParams({ k: params.secret }).toString()}`;
}

/** Malformed or absent fragment material is unusable, never a legacy lookup fallback. */
export function readStoredContentPublicShareSecretV1(fragment: string): string | null {
  const values = new URLSearchParams(fragment.replace(/^#/, ''));
  const keys = [...values.keys()];
  if (keys.length !== 1 || keys[0] !== 'k') return null;
  const secret = values.get('k');
  return secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null;
}
