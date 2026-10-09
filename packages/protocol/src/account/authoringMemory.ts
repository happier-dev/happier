import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';

export const AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1 = 'authoring_memory' as const;
export const AUTHORING_MEMORY_ROUTE_V1 = '/v1/account/authoring-memory' as const;
const PROJECT_LAST_OPENED_PREFIX = 'projectLastOpened:';
const ProjectAnchorSchema = lazyZodSchema(() => z.object({
  serverId: z.string().min(1).refine(value => value === value.trim()),
  projectKey: z.string().min(1).refine(value => value === value.trim()),
}).strict());
export type ProjectLastOpenedMemoryAnchorV1 = z.infer<typeof ProjectAnchorSchema>;
export const ProjectLastOpenedMemoryValueV1Schema = lazyZodSchema(() => z.number().finite().nonnegative());

export function buildProjectLastOpenedMemoryKeyV1(input: ProjectLastOpenedMemoryAnchorV1): string {
  const anchor = ProjectAnchorSchema.parse(input);
  return `${PROJECT_LAST_OPENED_PREFIX}${encodeURIComponent(anchor.serverId)}:${encodeURIComponent(anchor.projectKey)}`;
}
export function parseProjectLastOpenedMemoryKeyV1(key: string): ProjectLastOpenedMemoryAnchorV1 | null {
  if (!key.startsWith(PROJECT_LAST_OPENED_PREFIX)) return null;
  const parts = key.slice(PROJECT_LAST_OPENED_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    const anchor = ProjectAnchorSchema.safeParse({ serverId: decodeURIComponent(parts[0]!), projectKey: decodeURIComponent(parts[1]!) });
    return anchor.success && buildProjectLastOpenedMemoryKeyV1(anchor.data) === key ? anchor.data : null;
  } catch { return null; }
}

/** Engine scope identity is normalized by the authoring owner before transport. */
export const AuthoringMemoryKeyV1Schema = lazyZodSchema(() => z.union([
  z.literal('recentMachinePaths'),
  z.literal('lastUsedProfile'),
  z.string().refine(key => parseProjectLastOpenedMemoryKeyV1(key) !== null, 'Project recency requires a canonical qualified anchor'),
  z.string().startsWith('engineSelection:').refine(
    (key) => key.length > 'engineSelection:'.length && key === key.trim(),
    'Engine selection requires a nonempty canonical scope',
  ),
]));
export type AuthoringMemoryKeyV1 = z.infer<typeof AuthoringMemoryKeyV1Schema>;

/** Preserve opaque future engine carriers; interpretation stays client-owned. */
export const AuthoringMemoryValueV1Schema = StrictJsonValueSchema;
export type AuthoringMemoryValueV1 = z.infer<typeof AuthoringMemoryValueV1Schema>;
export function assertAuthoringMemoryValueForKeyV1(key: string, value: unknown): AuthoringMemoryValueV1 {
  AuthoringMemoryKeyV1Schema.parse(key);
  return parseProjectLastOpenedMemoryKeyV1(key)
    ? ProjectLastOpenedMemoryValueV1Schema.parse(value)
    : AuthoringMemoryValueV1Schema.parse(value);
}

/** Preserve retained alias carriers together under their one canonical row identity. */
export const AuthoringMemoryEngineSelectionsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  selectionsByScope: z.record(z.string(), AuthoringMemoryValueV1Schema),
}).strict());
export type AuthoringMemoryEngineSelectionsV1 = z.infer<typeof AuthoringMemoryEngineSelectionsV1Schema>;
export const StoredAuthoringMemoryEngineSelectionsV1Schema = createStoredReadSchema(AuthoringMemoryEngineSelectionsV1Schema);

/** E2EE opens must match the requested row before disclosing this value. */
export const AuthoringMemoryPrivatePayloadV1Schema = lazyZodSchema(() => z.object({
  key: AuthoringMemoryKeyV1Schema,
  value: AuthoringMemoryValueV1Schema,
}).strict().superRefine((payload, ctx) => {
  if (parseProjectLastOpenedMemoryKeyV1(payload.key) && !ProjectLastOpenedMemoryValueV1Schema.safeParse(payload.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'Project recency must be a nonnegative timestamp' });
  }
}));
export type AuthoringMemoryPrivatePayloadV1 = z.infer<typeof AuthoringMemoryPrivatePayloadV1Schema>;
export const StoredAuthoringMemoryPrivatePayloadV1Schema = createStoredReadSchema(AuthoringMemoryPrivatePayloadV1Schema);

export const AuthoringMemoryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: AuthoringMemoryValueV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
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
  key?: string,
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
  if (key !== undefined && content.t === 'plain') assertAuthoringMemoryValueForKeyV1(key, content.v);
  return content;
}

const RevisionV1Schema = lazyZodSchema(() => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
export const AuthoringMemoryRowV1Schema = lazyZodSchema(() => z.object({
  key: AuthoringMemoryKeyV1Schema,
  revision: RevisionV1Schema,
  content: AuthoringMemoryContentV1Schema.nullable(),
}).strict());
export type AuthoringMemoryRowV1 = z.infer<typeof AuthoringMemoryRowV1Schema>;
export const AuthoringMemoryListResponseV1Schema = lazyZodSchema(() => z.object({ rows: z.array(AuthoringMemoryRowV1Schema) }).strict());
export type AuthoringMemoryListResponseV1 = z.infer<typeof AuthoringMemoryListResponseV1Schema>;
export const AuthoringMemoryReadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('present'), revision: RevisionV1Schema, content: AuthoringMemoryContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('deleted'), revision: RevisionV1Schema }).strict(),
]));
export type AuthoringMemoryReadResponseV1 = z.infer<typeof AuthoringMemoryReadResponseV1Schema>;
export const AuthoringMemoryMutationRequestV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([RevisionV1Schema, z.literal('absent')]),
  content: AuthoringMemoryContentV1Schema.nullable(),
}).strict());
export type AuthoringMemoryMutationRequestV1 = z.infer<typeof AuthoringMemoryMutationRequestV1Schema>;
export const AuthoringMemoryMutationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), revision: RevisionV1Schema, cursor: RevisionV1Schema }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER) }).strict(),
]));
export type AuthoringMemoryMutationResponseV1 = z.infer<typeof AuthoringMemoryMutationResponseV1Schema>;
export const AuthoringMemoryStorageUnavailableV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('authoring_memory_storage_unavailable'),
}).strict());
export const AuthoringMemoryChangeHintV1Schema = lazyZodSchema(() => z.object({
  authoringMemory: z.literal(true),
  key: AuthoringMemoryKeyV1Schema,
  revision: RevisionV1Schema,
}).strict());
export type AuthoringMemoryChangeHintV1 = z.infer<typeof AuthoringMemoryChangeHintV1Schema>;
