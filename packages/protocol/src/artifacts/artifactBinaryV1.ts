import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { ArtifactStoredKindV1Schema } from './artifactKindV1.js';
import { BinaryBlobAccountEncryptionStageV1Schema, BinaryBlobContentKindV1Schema, BinaryBlobReferenceV1Schema, BinaryBlobStoredContentV1Schema } from '../storage/binaryBlobV1.js';

/** Sensitive file metadata stays inside the ordinary Artifact body envelope. */
export const ArtifactBlobReferenceV1Schema = BinaryBlobReferenceV1Schema;
export type ArtifactBlobReferenceV1 = z.infer<typeof ArtifactBlobReferenceV1Schema>;
export const ArtifactBodyV1Schema = lazyZodSchema(() => z.union([z.string(), ArtifactBlobReferenceV1Schema]));
export type ArtifactBodyV1 = z.infer<typeof ArtifactBodyV1Schema>;

/** Save attribution is private metadata, outside public-share content custody. */
export const ArtifactSavedByV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), accountId: preservedBoundedNfcString(191, 'Account ids') }),
  z.strictObject({ kind: z.literal('agent'), accountId: preservedBoundedNfcString(191, 'Account ids'),
    sessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')) }),
]));
export type ArtifactSavedByV1 = z.infer<typeof ArtifactSavedByV1Schema>;
/** Host-admitted workspace identity belongs to private revision custody, not public preview content. */
const workspaceSourceFile = {
  machineId: preservedBoundedNfcString(191, 'Machine ids'),
  path: z.string().check(z.minLength(1)),
  sha: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
};
export const ArtifactWorkspaceSourceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...workspaceSourceFile,
    sessionId: preservedBoundedNfcString(191, 'Session ids'),
    runId: zMini.optional(preservedBoundedNfcString(191, 'Run ids')) }),
  z.strictObject({ ...workspaceSourceFile, rootPath: z.string().check(z.minLength(1)) }),
]));
export type ArtifactWorkspaceSourceV1 = z.infer<typeof ArtifactWorkspaceSourceV1Schema>;
export const ArtifactRevisionProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  savedBy: ArtifactSavedByV1Schema,
  skillCreator: z.optional(ArtifactSavedByV1Schema),
  source: z.optional(ArtifactWorkspaceSourceV1Schema),
  restoredFromBodyVersion: z.optional(z.number().check(z.int(), z.positive(), z.int())),
}));
export type ArtifactRevisionProvenanceV1 = z.infer<typeof ArtifactRevisionProvenanceV1Schema>;
/** Separate owner/grant envelope, bound to the exact Artifact body revision. */
export const ArtifactPrivateRevisionMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), artifactId: preservedBoundedNfcString(191, 'Artifact ids'),
  bodyVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
  provenance: ArtifactRevisionProvenanceV1Schema,
}));
export type ArtifactPrivateRevisionMetadataV1 = z.infer<typeof ArtifactPrivateRevisionMetadataV1Schema>;
export const ArtifactPrivateRevisionMetadataV1StoredSchema = createStoredReadSchema(ArtifactPrivateRevisionMetadataV1Schema);
export const ArtifactBodyEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  body: z.nullable(ArtifactBodyV1Schema),
}));
export type ArtifactBodyEnvelopeV1 = z.infer<typeof ArtifactBodyEnvelopeV1Schema>;
export const ArtifactBodyEnvelopeV1StoredSchema = createStoredReadSchema(ArtifactBodyEnvelopeV1Schema);

/** Host-admitted caller context, never caller-authored document metadata, supplies new attribution. */
export function artifactSavedByFromActionContextV1(caller?: ActionExecutorContext): ArtifactSavedByV1 | undefined {
  if (!caller) return undefined;
  // Approved replay runs on the deciding surface, but the admitted proposal remains its author.
  const origin = caller.approvedActionReplay?.origin;
  const accountId = origin?.accountId ?? caller.runtimeAccountId;
  if (!accountId) return undefined;
  const author = origin?.caller ?? caller.actionCaller;
  const sessionId = author?.kind === 'session' ? author.sessionId : origin?.sessionId ?? caller.defaultSessionId;
  return ArtifactSavedByV1Schema.parse((origin?.surface ?? caller.surface) === 'agent' || author?.kind === 'session'
    ? { kind: 'agent', accountId, ...(sessionId ? { sessionId } : {}) }
    : { kind: 'person', accountId });
}

/** Mode is explicit before any binary opening or disclosure. Payloads use standard base64. */
export const ArtifactBlobStoredContentV1Schema = BinaryBlobStoredContentV1Schema;
export type ArtifactBlobStoredContentV1 = z.infer<typeof ArtifactBlobStoredContentV1Schema>;
/** Signed conversion directives identify staged bytes rather than carrying them inline. */
export const ArtifactBlobAccountEncryptionStageV1Schema = BinaryBlobAccountEncryptionStageV1Schema;
export type ArtifactBlobAccountEncryptionStageV1 = z.infer<typeof ArtifactBlobAccountEncryptionStageV1Schema>;
const uploadIdentity = {
  artifactId: z.string().check(z.minLength(1)), blobId: z.string().check(z.uuid()), t: BinaryBlobContentKindV1Schema,
  sizeBytes: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
};
const artifactUuid = z.string().check(z.uuid());
/** Destination metadata stays small; file bytes use the finite-transfer chunk owner. */
export const ArtifactBlobUploadInitV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), ...uploadIdentity, artifactId: artifactUuid,
    artifactKind: z.optional(ArtifactStoredKindV1Schema),
    header: z.string(), body: z.string(), dataEncryptionKey: z.string(),
    provenance: z.optional(z.nullable(z.string())), provenanceDataEncryptionKey: z.optional(z.nullable(z.string())) }),
  z.strictObject({ kind: z.literal('update'), ...uploadIdentity,
    artifactKind: z.optional(ArtifactStoredKindV1Schema),
    header: z.optional(z.string()), expectedHeaderVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    body: z.string(), expectedBodyVersion: z.number().check(z.int(), z.nonnegative()),
    provenance: z.optional(z.nullable(z.string())), provenanceDataEncryptionKey: z.optional(z.nullable(z.string())) }),
  z.strictObject({ kind: z.literal('encryption-conversion'), ...uploadIdentity, artifactId: artifactUuid }),
]));
export type ArtifactBlobUploadInitV1 = z.infer<typeof ArtifactBlobUploadInitV1Schema>;
export const ArtifactBlobWriteV1Schema = lazyZodSchema(() => z.strictObject({
  blobId: z.string().check(z.uuid()), content: z.optional(ArtifactBlobStoredContentV1Schema),
}));
export type ArtifactBlobWriteV1 = z.infer<typeof ArtifactBlobWriteV1Schema>;
export const ArtifactBlobReadResponseV1Schema = lazyZodSchema(() => z.required(ArtifactBlobWriteV1Schema, { content: true }));
export type ArtifactBlobReadResponseV1 = z.infer<typeof ArtifactBlobReadResponseV1Schema>;
