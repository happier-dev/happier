import { z } from 'zod';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';

/** Sensitive file metadata stays inside the ordinary Artifact body envelope. */
export const ArtifactBlobReferenceV1Schema = z.object({
  blobId: z.string().uuid(), mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ArtifactBlobReferenceV1 = z.infer<typeof ArtifactBlobReferenceV1Schema>;
export const ArtifactBodyV1Schema = z.union([z.string(), ArtifactBlobReferenceV1Schema]);
export type ArtifactBodyV1 = z.infer<typeof ArtifactBodyV1Schema>;

/** Save attribution is content, protected by the same custody as the revision body. */
export const ArtifactSavedByV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), accountId: preservedBoundedNfcString(191, 'Account ids') }).strict(),
  z.object({ kind: z.literal('agent'), accountId: preservedBoundedNfcString(191, 'Account ids'),
    sessionId: preservedBoundedNfcString(191, 'Session ids').optional() }).strict(),
]);
export type ArtifactSavedByV1 = z.infer<typeof ArtifactSavedByV1Schema>;
export const ArtifactRevisionProvenanceV1Schema = z.object({
  savedBy: ArtifactSavedByV1Schema,
  restoredFromBodyVersion: z.number().int().positive().safe().optional(),
}).strict();
export type ArtifactRevisionProvenanceV1 = z.infer<typeof ArtifactRevisionProvenanceV1Schema>;
export const ArtifactBodyEnvelopeV1Schema = z.object({
  body: ArtifactBodyV1Schema.nullable(),
  provenance: ArtifactRevisionProvenanceV1Schema.optional(),
}).strict();
export type ArtifactBodyEnvelopeV1 = z.infer<typeof ArtifactBodyEnvelopeV1Schema>;

/** Host-admitted caller context, never caller-authored document metadata, supplies new attribution. */
export function artifactSavedByFromActionContextV1(caller?: ActionExecutorContext): ArtifactSavedByV1 | undefined {
  if (!caller?.runtimeAccountId) return undefined;
  const sessionId = caller.actionCaller?.kind === 'session' ? caller.actionCaller.sessionId : caller.defaultSessionId;
  return ArtifactSavedByV1Schema.parse(caller.surface === 'agent' || caller.actionCaller?.kind === 'session'
    ? { kind: 'agent', accountId: caller.runtimeAccountId, ...(sessionId ? { sessionId } : {}) }
    : { kind: 'person', accountId: caller.runtimeAccountId });
}

/** Mode is explicit before any binary opening or disclosure. Payloads use standard base64. */
const bytesBase64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const ArtifactBlobStoredContentV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: bytesBase64 }).strict(),
  z.object({ t: z.literal('encrypted'), c: bytesBase64 }).strict(),
]);
export type ArtifactBlobStoredContentV1 = z.infer<typeof ArtifactBlobStoredContentV1Schema>;
/** Signed conversion directives identify staged bytes rather than carrying them inline. */
export const ArtifactBlobAccountEncryptionStageV1Schema = z.object({
  t: z.enum(['plain', 'encrypted']), uploadId: z.string().uuid(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ArtifactBlobAccountEncryptionStageV1 = z.infer<typeof ArtifactBlobAccountEncryptionStageV1Schema>;
const uploadIdentity = {
  artifactId: z.string().min(1), blobId: z.string().uuid(), t: z.enum(['plain', 'encrypted']),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const artifactUuid = z.string().uuid();
/** Destination metadata stays small; file bytes use the finite-transfer chunk owner. */
export const ArtifactBlobUploadInitV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), ...uploadIdentity, artifactId: artifactUuid,
    header: z.string(), body: z.string(), dataEncryptionKey: z.string() }).strict(),
  z.object({ kind: z.literal('update'), ...uploadIdentity,
    header: z.string().optional(), expectedHeaderVersion: z.number().int().nonnegative().optional(),
    body: z.string(), expectedBodyVersion: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('encryption-conversion'), ...uploadIdentity, artifactId: artifactUuid }).strict(),
]);
export type ArtifactBlobUploadInitV1 = z.infer<typeof ArtifactBlobUploadInitV1Schema>;
export const ArtifactBlobWriteV1Schema = z.object({
  blobId: z.string().uuid(), content: ArtifactBlobStoredContentV1Schema.optional(),
}).strict();
export type ArtifactBlobWriteV1 = z.infer<typeof ArtifactBlobWriteV1Schema>;
export const ArtifactBlobReadResponseV1Schema = ArtifactBlobWriteV1Schema.required({ content: true });
export type ArtifactBlobReadResponseV1 = z.infer<typeof ArtifactBlobReadResponseV1Schema>;
