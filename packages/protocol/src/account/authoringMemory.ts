import { z } from 'zod';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';

export const AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1 = 'authoring_memory' as const;
export const AUTHORING_MEMORY_ROUTE_V1 = '/v1/account/authoring-memory' as const;

/** Engine scope identity is normalized by the authoring owner before transport. */
export const AuthoringMemoryKeyV1Schema = z.union([
  z.literal('recentMachinePaths'),
  z.literal('lastUsedProfile'),
  z.string().startsWith('engineSelection:').refine(
    (key) => key.length > 'engineSelection:'.length && key === key.trim(),
    'Engine selection requires a nonempty canonical scope',
  ),
]);
export type AuthoringMemoryKeyV1 = z.infer<typeof AuthoringMemoryKeyV1Schema>;

/** Preserve opaque future engine carriers; interpretation stays client-owned. */
export const AuthoringMemoryValueV1Schema = StrictJsonValueSchema;
export type AuthoringMemoryValueV1 = z.infer<typeof AuthoringMemoryValueV1Schema>;

/** Preserve retained alias carriers together under their one canonical row identity. */
export const AuthoringMemoryEngineSelectionsV1Schema = z.object({
  v: z.literal(1),
  selectionsByScope: z.record(z.string(), AuthoringMemoryValueV1Schema),
}).strict();
export type AuthoringMemoryEngineSelectionsV1 = z.infer<typeof AuthoringMemoryEngineSelectionsV1Schema>;
export const StoredAuthoringMemoryEngineSelectionsV1Schema = createStoredReadSchema(AuthoringMemoryEngineSelectionsV1Schema);

/** E2EE opens must match the requested row before disclosing this value. */
export const AuthoringMemoryPrivatePayloadV1Schema = z.object({
  key: AuthoringMemoryKeyV1Schema,
  value: AuthoringMemoryValueV1Schema,
}).strict();
export type AuthoringMemoryPrivatePayloadV1 = z.infer<typeof AuthoringMemoryPrivatePayloadV1Schema>;
export const StoredAuthoringMemoryPrivatePayloadV1Schema = createStoredReadSchema(AuthoringMemoryPrivatePayloadV1Schema);

export const AuthoringMemoryContentV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: AuthoringMemoryValueV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]);
export type AuthoringMemoryContentV1 = z.infer<typeof AuthoringMemoryContentV1Schema>;
export const StoredAuthoringMemoryContentV1Schema = createStoredReadSchema(AuthoringMemoryContentV1Schema);

export class AuthoringMemoryContentModeMismatchError extends Error {
  constructor() {
    super('Authoring memory content does not match the Account encryption mode');
    this.name = 'AuthoringMemoryContentModeMismatchError';
  }
}

export function assertAuthoringMemoryContentForModeV1(
  input: unknown,
  mode: 'plain' | 'e2ee',
): AuthoringMemoryContentV1 {
  const content = StoredAuthoringMemoryContentV1Schema.parse(input);
  if (
    (mode === 'plain' && content.t !== 'plain')
    || (mode === 'e2ee' && (
      content.t !== 'encrypted'
      || !isAccountScopedBlobCiphertextForKind({ kind: AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1, ciphertext: content.c })
    ))
  ) {
    throw new AuthoringMemoryContentModeMismatchError();
  }
  return content;
}

const RevisionV1Schema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const AuthoringMemoryRowV1Schema = z.object({
  key: AuthoringMemoryKeyV1Schema,
  revision: RevisionV1Schema,
  content: AuthoringMemoryContentV1Schema.nullable(),
}).strict();
export type AuthoringMemoryRowV1 = z.infer<typeof AuthoringMemoryRowV1Schema>;
export const AuthoringMemoryListResponseV1Schema = z.object({ rows: z.array(AuthoringMemoryRowV1Schema) }).strict();
export type AuthoringMemoryListResponseV1 = z.infer<typeof AuthoringMemoryListResponseV1Schema>;
export const AuthoringMemoryReadResponseV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('present'), revision: RevisionV1Schema, content: AuthoringMemoryContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('deleted'), revision: RevisionV1Schema }).strict(),
]);
export type AuthoringMemoryReadResponseV1 = z.infer<typeof AuthoringMemoryReadResponseV1Schema>;
export const AuthoringMemoryMutationRequestV1Schema = z.object({
  expectedRevision: z.union([RevisionV1Schema, z.literal('absent')]),
  content: AuthoringMemoryContentV1Schema.nullable(),
}).strict();
export type AuthoringMemoryMutationRequestV1 = z.infer<typeof AuthoringMemoryMutationRequestV1Schema>;
export const AuthoringMemoryMutationResponseV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), revision: RevisionV1Schema, cursor: RevisionV1Schema }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
export type AuthoringMemoryMutationResponseV1 = z.infer<typeof AuthoringMemoryMutationResponseV1Schema>;
export const AuthoringMemoryStorageUnavailableV1Schema = z.object({
  error: z.literal('authoring_memory_storage_unavailable'),
}).strict();
export const AuthoringMemoryChangeHintV1Schema = z.object({
  authoringMemory: z.literal(true),
  key: AuthoringMemoryKeyV1Schema,
  revision: RevisionV1Schema,
}).strict();
export type AuthoringMemoryChangeHintV1 = z.infer<typeof AuthoringMemoryChangeHintV1Schema>;
