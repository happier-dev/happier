import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';
import { WorkflowDefinitionIdV1Schema } from '../workflows/workflowIdsV1.js';
import { WorkflowProjectTargetV1Schema } from '../workflows/workflowWorkspaceV1.js';

export const AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1 = 'authoring_memory' as const;
export const AUTHORING_MEMORY_ROUTE_V1 = '/v1/account/authoring-memory' as const;
const PROJECT_LAST_OPENED_PREFIX = 'projectLastOpened:';
const WORKFLOW_PROJECT_PREFIX = 'workflowProject:';
export const WorkflowProjectTargetsByDefinitionIdV1Schema = lazyZodSchema(() => z.record(WorkflowDefinitionIdV1Schema, WorkflowProjectTargetV1Schema));
export type WorkflowProjectTargetsByDefinitionIdV1 = z.infer<typeof WorkflowProjectTargetsByDefinitionIdV1Schema>;

export function buildWorkflowProjectMemoryKeyV1(definitionId: string): string {
  return `${WORKFLOW_PROJECT_PREFIX}${encodeURIComponent(WorkflowDefinitionIdV1Schema.parse(definitionId))}`;
}
export function parseWorkflowProjectMemoryKeyV1(key: string): string | null {
  if (!key.startsWith(WORKFLOW_PROJECT_PREFIX)) return null;
  try {
    const id = WorkflowDefinitionIdV1Schema.safeParse(decodeURIComponent(key.slice(WORKFLOW_PROJECT_PREFIX.length)));
    return id.success && buildWorkflowProjectMemoryKeyV1(id.data) === key ? id.data : null;
  } catch { return null; }
}
const ProjectAnchorSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1), z.refine(value => value === value.trim())),
  projectKey: z.string().check(z.minLength(1), z.refine(value => value === value.trim())),
}));
export type ProjectLastOpenedMemoryAnchorV1 = z.infer<typeof ProjectAnchorSchema>;
export const ProjectLastOpenedMemoryValueV1Schema = lazyZodSchema(() => z.number().check(z.nonnegative()));

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
  z.string().check(z.refine(key => parseWorkflowProjectMemoryKeyV1(key) !== null, 'Workflow projects require a canonical definition identity')),
  z.string().check(z.refine(key => parseProjectLastOpenedMemoryKeyV1(key) !== null, 'Project recency requires a canonical qualified anchor')),
  z.string().check(z.startsWith('engineSelection:'), z.refine((key) => key.length > 'engineSelection:'.length && key === key.trim(), 'Engine selection requires a nonempty canonical scope')),
]));
export type AuthoringMemoryKeyV1 = z.infer<typeof AuthoringMemoryKeyV1Schema>;

/** Preserve opaque future engine carriers; interpretation stays client-owned. */
export const AuthoringMemoryValueV1Schema = StrictJsonValueSchema;
export type AuthoringMemoryValueV1 = z.infer<typeof AuthoringMemoryValueV1Schema>;
const StoredWorkflowProjectTargetV1Schema = createStoredReadSchema(WorkflowProjectTargetV1Schema);
function authoringMemoryValueSchemaForKeyV1(key: string, stored: boolean): z.ZodMiniType<AuthoringMemoryValueV1> {
  AuthoringMemoryKeyV1Schema.parse(key);
  return parseProjectLastOpenedMemoryKeyV1(key)
    ? ProjectLastOpenedMemoryValueV1Schema
    : parseWorkflowProjectMemoryKeyV1(key) !== null ? (stored ? StoredWorkflowProjectTargetV1Schema : WorkflowProjectTargetV1Schema)
    : AuthoringMemoryValueV1Schema;
}
export function assertAuthoringMemoryValueForKeyV1(key: string, value: unknown): AuthoringMemoryValueV1 {
  return authoringMemoryValueSchemaForKeyV1(key, false).parse(value);
}
export function assertStoredAuthoringMemoryValueForKeyV1(key: string, value: unknown): AuthoringMemoryValueV1 {
  return authoringMemoryValueSchemaForKeyV1(key, true).parse(value);
}

/** Preserve retained alias carriers together under their one canonical row identity. */
export const AuthoringMemoryEngineSelectionsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  selectionsByScope: z.record(z.string(), AuthoringMemoryValueV1Schema),
}));
export type AuthoringMemoryEngineSelectionsV1 = z.infer<typeof AuthoringMemoryEngineSelectionsV1Schema>;
export const StoredAuthoringMemoryEngineSelectionsV1Schema = createStoredReadSchema(AuthoringMemoryEngineSelectionsV1Schema);

/** E2EE opens must match the requested row before disclosing this value. */
const AuthoringMemoryPrivatePayloadShapeV1Schema = lazyZodSchema(() => z.strictObject({
  key: AuthoringMemoryKeyV1Schema,
  value: AuthoringMemoryValueV1Schema,
}));
function projectStoredAuthoringMemoryPrivatePayload(schema: typeof AuthoringMemoryPrivatePayloadShapeV1Schema) {
  return z.pipe(schema, z.transform((payload, ctx) => {
    const value = authoringMemoryValueSchemaForKeyV1(payload.key, true).safeParse(payload.value);
    if (!value.success) {
      ctx.issues.push({ code: 'custom', path: ['value'], message: 'Authoring memory value does not match its row key', input: ctx.value });
      return z.NEVER;
    }
    return { key: payload.key, value: value.data };
  }));
}
export const AuthoringMemoryPrivatePayloadV1Schema = defineStoredReadProjection(
  lazyZodSchema(() => AuthoringMemoryPrivatePayloadShapeV1Schema.check(z.superRefine((payload, ctx) => {
    if (!authoringMemoryValueSchemaForKeyV1(payload.key, false).safeParse(payload.value).success) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Authoring memory value does not match its row key' });
    }
  }))),
  () => projectStoredAuthoringMemoryPrivatePayload(createStoredReadSchema(AuthoringMemoryPrivatePayloadShapeV1Schema)),
);
export type AuthoringMemoryPrivatePayloadV1 = z.infer<typeof AuthoringMemoryPrivatePayloadV1Schema>;
export const StoredAuthoringMemoryPrivatePayloadV1Schema = createStoredReadSchema(AuthoringMemoryPrivatePayloadV1Schema);

export const AuthoringMemoryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: AuthoringMemoryValueV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
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
  if (key !== undefined && content.t === 'plain') {
    return { t: 'plain', v: assertStoredAuthoringMemoryValueForKeyV1(key, content.v) };
  }
  return content;
}

const RevisionV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
export const AuthoringMemoryRowV1Schema = lazyZodSchema(() => z.strictObject({
  key: AuthoringMemoryKeyV1Schema,
  revision: RevisionV1Schema,
  content: z.nullable(AuthoringMemoryContentV1Schema),
}));
export type AuthoringMemoryRowV1 = z.infer<typeof AuthoringMemoryRowV1Schema>;
export const AuthoringMemoryListResponseV1Schema = lazyZodSchema(() => z.strictObject({ rows: z.array(AuthoringMemoryRowV1Schema) }));
export type AuthoringMemoryListResponseV1 = z.infer<typeof AuthoringMemoryListResponseV1Schema>;
export const AuthoringMemoryReadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('present'), revision: RevisionV1Schema, content: AuthoringMemoryContentV1Schema }),
  z.strictObject({ status: z.literal('absent') }),
  z.strictObject({ status: z.literal('deleted'), revision: RevisionV1Schema }),
]));
export type AuthoringMemoryReadResponseV1 = z.infer<typeof AuthoringMemoryReadResponseV1Schema>;
export const AuthoringMemoryMutationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([RevisionV1Schema, z.literal('absent')]),
  content: z.nullable(AuthoringMemoryContentV1Schema),
}));
export type AuthoringMemoryMutationRequestV1 = z.infer<typeof AuthoringMemoryMutationRequestV1Schema>;
export const AuthoringMemoryMutationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('updated'), revision: RevisionV1Schema, cursor: RevisionV1Schema }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1), z.maximum(Number.MAX_SAFE_INTEGER)) }),
]));
export type AuthoringMemoryMutationResponseV1 = z.infer<typeof AuthoringMemoryMutationResponseV1Schema>;
export const AuthoringMemoryStorageUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('authoring_memory_storage_unavailable'),
}));
export const AuthoringMemoryChangeHintV1Schema = lazyZodSchema(() => z.strictObject({
  authoringMemory: z.literal(true),
  key: AuthoringMemoryKeyV1Schema,
  revision: RevisionV1Schema,
}));
export type AuthoringMemoryChangeHintV1 = z.infer<typeof AuthoringMemoryChangeHintV1Schema>;
