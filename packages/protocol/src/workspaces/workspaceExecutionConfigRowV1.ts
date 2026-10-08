import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';
import { WorkspaceExecutionConfigAddressV1Schema, WorkspaceExecutionSettingsV1Schema, type WorkspaceExecutionConfigAddressV1 } from './projectWorkerPreferencesV1.js';

export const WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 = '/v1/projects/execution/config' as const;
export const WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1 = '@happier/account/workspace-execution-config/v1/' as const;
export const WORKSPACE_EXECUTION_CONFIG_ACCOUNT_SCOPED_BLOB_KIND_V1 = 'workspace_execution_config' as const;
export const WorkspaceExecutionConfigRowIdV1Schema = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{64}$/));

/** Qualified identity contains neither checkout roots nor Machine paths. */
export function buildWorkspaceExecutionConfigRowIdV1(input: WorkspaceExecutionConfigAddressV1): string {
  const address = WorkspaceExecutionConfigAddressV1Schema.parse(input);
  return computeCanonicalDomainSeparatedHexDigest('happier.workspace-execution-config.v1', [address.serverId, address.refId]);
}
export function buildWorkspaceExecutionConfigPhysicalKeyV1(rowId: string): string {
  return `${WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1}${WorkspaceExecutionConfigRowIdV1Schema.parse(rowId)}`;
}
export function parseWorkspaceExecutionConfigPhysicalKeyV1(key: string): string | null {
  if (!key.startsWith(WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1)) return null;
  const parsed = WorkspaceExecutionConfigRowIdV1Schema.safeParse(key.slice(WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1.length));
  return parsed.success ? parsed.data : null;
}

/** Clients check this binding after opening opaque E2EE content. */
export const WorkspaceExecutionConfigPrivatePayloadV1Schema = lazyZodSchema(() => z.object({
  rowId: WorkspaceExecutionConfigRowIdV1Schema, value: WorkspaceExecutionSettingsV1Schema,
}).strict());
export const StoredWorkspaceExecutionConfigPrivatePayloadV1Schema = createStoredReadSchema(WorkspaceExecutionConfigPrivatePayloadV1Schema);
export const WorkspaceExecutionConfigContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: WorkspaceExecutionSettingsV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type WorkspaceExecutionConfigContentV1 = z.infer<typeof WorkspaceExecutionConfigContentV1Schema>;
export const StoredWorkspaceExecutionConfigContentV1Schema = createStoredReadSchema(WorkspaceExecutionConfigContentV1Schema);
export function assertWorkspaceExecutionConfigContentForModeV1(input: unknown, mode: 'plain' | 'e2ee'): WorkspaceExecutionConfigContentV1 {
  const content = StoredWorkspaceExecutionConfigContentV1Schema.parse(input);
  if ((mode === 'plain' && content.t !== 'plain') || (mode === 'e2ee' && (content.t !== 'encrypted'
    || !isAccountScopedBlobCiphertextForKind({ kind: WORKSPACE_EXECUTION_CONFIG_ACCOUNT_SCOPED_BLOB_KIND_V1, ciphertext: content.c })))) {
    throw new Error('Workspace execution config content does not match Account mode');
  }
  return content;
}

const RevisionSchema = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const WorkspaceExecutionConfigRowV1Schema = lazyZodSchema(() => z.object({
  rowId: WorkspaceExecutionConfigRowIdV1Schema, revision: RevisionSchema, content: StoredWorkspaceExecutionConfigContentV1Schema.nullable(),
}).strict());
export type WorkspaceExecutionConfigRowV1 = z.infer<typeof WorkspaceExecutionConfigRowV1Schema>;
export const WorkspaceExecutionConfigReadRequestV1Schema = lazyZodSchema(() => z.object({ address: WorkspaceExecutionConfigAddressV1Schema }).strict());
export const WorkspaceExecutionConfigReadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('present'), revision: RevisionSchema, content: StoredWorkspaceExecutionConfigContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('deleted'), revision: RevisionSchema }).strict(),
]));
export type WorkspaceExecutionConfigReadResponseV1 = z.infer<typeof WorkspaceExecutionConfigReadResponseV1Schema>;
export const WorkspaceExecutionConfigMutationRequestV1Schema = lazyZodSchema(() => z.object({
  address: WorkspaceExecutionConfigAddressV1Schema,
  expectedRevision: z.union([RevisionSchema, z.literal('absent')]), content: WorkspaceExecutionConfigContentV1Schema.nullable(),
}).strict());
export const WorkspaceExecutionConfigMutationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), revision: RevisionSchema, cursor: RevisionSchema }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER) }).strict(),
]));
export type WorkspaceExecutionConfigMutationResponseV1 = z.infer<typeof WorkspaceExecutionConfigMutationResponseV1Schema>;
export const WorkspaceExecutionConfigListResponseV1Schema = lazyZodSchema(() => z.object({ rows: z.array(WorkspaceExecutionConfigRowV1Schema) }).strict());
export const WorkspaceExecutionConfigStorageUnavailableV1Schema = lazyZodSchema(() => z.object({ error: z.literal('workspace_execution_config_storage_unavailable') }).strict());
export const WorkspaceExecutionConfigChangeHintV1Schema = lazyZodSchema(() => z.object({
  workspaceExecutionConfig: z.literal(true), rowId: WorkspaceExecutionConfigRowIdV1Schema, revision: RevisionSchema,
}).strict());
