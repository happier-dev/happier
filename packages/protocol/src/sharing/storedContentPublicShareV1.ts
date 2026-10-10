import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { encodeBase64 } from '../crypto/base64.js';
import { SessionStoredMessageContentSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { ArtifactBlobReadResponseV1Schema } from '../artifacts/artifactBinaryV1.js';
import { SessionSystemRecordSchema } from '../sessions/system/records/sessionSystemRecord.js';
import { SessionSystemRecordContentSchema } from '../sessions/system/records/sessionSystemRecordContent.js';
import { SessionTranscriptSurfaceItemReferenceV1Schema } from '../sessions/messages/transcriptObservationV1.js';
import { SessionMessageRoleSchema } from '../sessions/messages/sessionMessageRole.js';

/** Closed authority-bearing HTTP objects; no fragment secret is a transport field. */
export const StoredContentPublicShareSubjectV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['session', 'artifact']), id: z.string().min(1),
}).strict());
export type StoredContentPublicShareSubjectV1 = z.infer<typeof StoredContentPublicShareSubjectV1Schema>;

export const StoredContentPublicShareKeyDerivationV1Schema = lazyZodSchema(() => z.enum(['fragment_v1', 'legacy_token_v1']));
export const StoredContentPublicShareCreateRequestV1Schema = lazyZodSchema(() => z.object({
  subject: StoredContentPublicShareSubjectV1Schema,
  lookupId: z.string().min(1),
  encryptedDataKey: z.string().min(1).nullable().optional(),
  keyDerivation: z.literal('fragment_v1'),
  expiresAt: z.number().int().nonnegative().optional(),
  maxUses: z.number().int().positive().optional(),
  isConsentRequired: z.boolean().optional(),
  networkOff: z.boolean().optional(),
}).strict());
export type StoredContentPublicShareCreateRequestV1 = z.infer<typeof StoredContentPublicShareCreateRequestV1Schema>;

export const StoredContentPublicShareV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1), subject: StoredContentPublicShareSubjectV1Schema,
  expiresAt: z.number().int().nonnegative().nullable(), maxUses: z.number().int().positive().nullable(),
  useCount: z.number().int().nonnegative(), isConsentRequired: z.boolean(), networkOff: z.boolean().default(false),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  keyDerivation: StoredContentPublicShareKeyDerivationV1Schema,
}).strict());
export type StoredContentPublicShareV1 = z.infer<typeof StoredContentPublicShareV1Schema>;
/** Use limits govern new viewers; expiry or deletion ends the publication itself. */
export function isStoredContentPublicShareActiveV1(publication: Readonly<{ expiresAt: number | null }> | null, nowMs: number): boolean {
  return publication !== null && !(publication.expiresAt !== null && publication.expiresAt <= nowMs);
}
export const StoredContentPublicSharesListResponseV1Schema = lazyZodSchema(() => z.object({
  publicShares: z.array(StoredContentPublicShareV1Schema),
}).strict());
export type StoredContentPublicSharesListResponseV1 = z.infer<typeof StoredContentPublicSharesListResponseV1Schema>;
export const StoredContentPublicShareCreateResponseV1Schema = lazyZodSchema(() => z.object({
  publicShare: StoredContentPublicShareV1Schema,
  isolatedOrigin: z.string().url(),
}).strict());

export const StoredContentPublicShareAccessLogV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1), accessedAt: z.number().int().nonnegative(),
  ipAddress: z.string().nullable(), userAgent: z.string().nullable(),
}).strict());
export const StoredContentPublicShareAccessLogResponseV1Schema = lazyZodSchema(() => z.object({
  accessLog: z.array(StoredContentPublicShareAccessLogV1Schema),
}).strict());

export const StoredContentPublicShareReadResponseV1Schema = lazyZodSchema(() => z.object({
  subject: StoredContentPublicShareSubjectV1Schema,
  encryptionMode: z.enum(['e2ee', 'plain']),
  encryptedDataKey: z.string().min(1).nullable(),
  keyDerivation: StoredContentPublicShareKeyDerivationV1Schema,
  isConsentRequired: z.boolean(),
  networkOff: z.boolean().default(false),
  messagesAccessToken: z.string().min(1).nullable().optional(),
  content: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('artifact'), header: z.string(), body: z.string(),
      headerVersion: z.number().int().positive(), bodyVersion: z.number().int().positive(),
      blob: ArtifactBlobReadResponseV1Schema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('session'), metadata: z.string().nullable(), metadataVersion: z.number().int().nonnegative(),
      metadataLayoutVersion: z.number().int().optional(), agentState: z.string().nullable(),
      agentStateVersion: z.number().int().nonnegative(), messages: z.array(z.object({
        id: z.string().min(1), seq: z.number().int().nonnegative(), localId: z.string().nullable().optional(),
        createdAt: z.number().finite(), content: SessionStoredMessageContentSchema,
        surfaceItemReference: z.lazy(() => SessionTranscriptSurfaceItemReferenceV1Schema).nullable().optional(),
        messageRole: SessionMessageRoleSchema.optional(),
      })),
      hasMore: z.boolean(), nextBeforeSeq: z.number().int().nonnegative().nullable(),
    }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  if (value.subject.kind !== value.content.kind) context.addIssue({ code: 'custom', message: 'Public-share subject/content mismatch' });
  if ((value.encryptionMode === 'e2ee') !== (value.encryptedDataKey !== null)) {
    context.addIssue({ code: 'custom', message: 'Public-share mode/key mismatch' });
  }
}));
export type StoredContentPublicShareReadResponseV1 = z.infer<typeof StoredContentPublicShareReadResponseV1Schema>;

/** A message capability is the only public visual selector; item ids are not request authority. */
export const StoredContentPublicShareVisualReadResponseV1Schema = lazyZodSchema(() => z.object({
  messageId: z.string().min(1),
  encryptionMode: z.enum(['plain', 'e2ee']),
  networkOff: z.boolean(),
  reference: z.lazy(() => SessionTranscriptSurfaceItemReferenceV1Schema),
  record: SessionSystemRecordSchema.extend({ content: SessionSystemRecordContentSchema }),
}).strict().superRefine((value, context) => {
  if ((value.encryptionMode === 'plain') !== (value.record.content.t === 'plain')
    || value.record.address.owner !== 'host' || value.record.address.namespace !== 'surface'
    || value.record.address.kind !== 'item.v1' || value.record.address.localId !== value.reference.itemId) {
    context.addIssue({ code: 'custom', message: 'Public visual mode or addressed identity mismatch' });
  }
}));
export type StoredContentPublicShareVisualReadResponseV1 = z.infer<typeof StoredContentPublicShareVisualReadResponseV1Schema>;

/** Independent cryptographic capabilities: the lookup is HTTP-visible, the secret is local. */
export function generateStoredContentPublicShareMaterialV1(randomBytes: (length: number) => Uint8Array): Readonly<{ lookupId: string; secret: string }> {
  const lookup = randomBytes(32);
  const secret = randomBytes(32);
  if (lookup.byteLength !== 32 || secret.byteLength !== 32) throw new Error('Public-share material requires 32 random bytes');
  return { lookupId: encodeBase64(lookup, 'base64url'), secret: encodeBase64(secret, 'base64url') };
}

export function buildStoredContentPublicShareUrlV1(params: Readonly<{ origin: string; lookupId: string; secret: string }>): string {
  const origin = new URL(params.origin);
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw new Error('Invalid public-share origin');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid public-share origin');
  if (!params.lookupId || !params.secret) throw new Error('Public-share material is required');
  return `${origin.origin}/s/${encodeURIComponent(params.lookupId)}#${new URLSearchParams({ k: params.secret }).toString()}`;
}

/** Malformed or absent fragment material is unusable, never a legacy lookup fallback. */
export function readStoredContentPublicShareSecretV1(fragment: string): string | null {
  const values = new URLSearchParams(fragment.replace(/^#/, ''));
  const keys = [...values.keys()];
  if (keys.length !== 1 || keys[0] !== 'k') return null;
  const secret = values.get('k');
  return secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null;
}
