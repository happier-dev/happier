import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StoredJsonContentEnvelopeSchema, TaskResourceStoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import { PrincipalRefV1Schema } from '../teams/principal.js';
import { AccountRecipientEnvelopeUnavailableReasonSchema } from '../account/encryptionMode.js';
import { ResourceAccessLevelV1Schema, ResourceCallerAccessV1Schema, ResourceAccessGrantRowV1Schema,
  ResourceRecipientKeyEnvelopeInputV1Schema, ResourceRecipientKeyEnvelopesV1Schema,
  ResourceRecipientKeyEnvelopeCommitInputV1Schema, ResourceRecipientKeyEnvelopeCommitResponseV1Schema,
  ResourceAccessRecipientCensusV1Schema } from '../teams/resourceGrantAccessV1.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';

/** Closed V1 addresses locate one owner's incumbent todo.<id> row. Home routing is external. */
export const TaskResourceAddressV1Schema = lazyZodSchema(() => z.strictObject({
  ownerAccountId: z.string().check(z.minLength(1)),
  taskId: z.string().check(z.minLength(1), z.refine(id => id !== 'index')),
}));
export type TaskResourceAddressV1 = z.infer<typeof TaskResourceAddressV1Schema>;

/** Content-free AccountChange identity; the kv change owner retains delivery/cursor semantics. */
export function buildTaskResourceChangeEntityIdV1(address: TaskResourceAddressV1): string {
  return `task:${encodeURIComponent(address.ownerAccountId)}:${encodeURIComponent(address.taskId)}`;
}
export function readTaskResourceChangeEntityIdV1(entityId: string): TaskResourceAddressV1 | null {
  const parts = entityId.split(':');
  if (parts.length !== 3 || parts[0] !== 'task') return null;
  try {
    const parsed = TaskResourceAddressV1Schema.safeParse({ ownerAccountId: decodeURIComponent(parts[1]!), taskId: decodeURIComponent(parts[2]!) });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export const TaskResourceContentV1Schema = lazyZodSchema(() => z.union([
  TaskResourceStoredJsonContentEnvelopeSchema, StoredJsonContentEnvelopeSchema,
]));
export type TaskResourceContentV1 = z.infer<typeof TaskResourceContentV1Schema>;
const ownerDisplayName = z.optional(z.nullable(z.string()));
export const TaskResourceV1Schema = lazyZodSchema(() => z.extend(TaskResourceAddressV1Schema, {
  version: z.number().check(z.int(), z.nonnegative()),
  content: TaskResourceContentV1Schema,
  access: ResourceCallerAccessV1Schema,
  encryptionMode: z.enum(['plain', 'e2ee']),
  encryptedDataKey: z.nullable(SessionDataKeyEnvelopeBytesV1Schema),
  ownerDisplayName,
}));
export type TaskResourceV1 = z.infer<typeof TaskResourceV1Schema>;
export const TaskResourceUnavailableV1Schema = lazyZodSchema(() => z.extend(TaskResourceAddressV1Schema, {
  error: z.literal('task_content_unavailable'),
  reason: z.union([AccountRecipientEnvelopeUnavailableReasonSchema, z.literal('recipient_key_pending'), z.literal('task_content_invalid')]),
}));
export type TaskResourceUnavailableV1 = z.infer<typeof TaskResourceUnavailableV1Schema>;
export const TaskResourcesListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  tasks: z.array(TaskResourceV1Schema),
  unavailableTasks: z.optional(z.array(TaskResourceUnavailableV1Schema)),
}));
export type TaskResourcesListResponseV1 = z.infer<typeof TaskResourcesListResponseV1Schema>;
export const TaskResourceMutateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  expectedVersion: z.number().check(z.int(), z.nonnegative()), content: TaskResourceContentV1Schema,
}));
export type TaskResourceMutateRequestV1 = z.infer<typeof TaskResourceMutateRequestV1Schema>;
export const TaskResourcePromotionV1Schema = lazyZodSchema(() => z.strictObject({
  expectedVersion: z.number().check(z.int(), z.nonnegative()),
  content: TaskResourceStoredJsonContentEnvelopeSchema,
  ownerKeyEnvelope: ResourceRecipientKeyEnvelopeInputV1Schema,
  recipientKeyEnvelopes: ResourceRecipientKeyEnvelopesV1Schema,
}));
export type TaskResourcePromotionV1 = z.infer<typeof TaskResourcePromotionV1Schema>;
export const TaskAccessGrantSetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  principal: PrincipalRefV1Schema, accessLevel: ResourceAccessLevelV1Schema,
  promotion: z.optional(TaskResourcePromotionV1Schema),
}));
export type TaskAccessGrantSetRequestV1 = z.infer<typeof TaskAccessGrantSetRequestV1Schema>;
export const TaskAccessGrantRemoveRequestV1Schema = lazyZodSchema(() => z.strictObject({ principal: PrincipalRefV1Schema }));
export type TaskAccessGrantRemoveRequestV1 = z.infer<typeof TaskAccessGrantRemoveRequestV1Schema>;
export const TaskRecipientReadinessV1Schema = lazyZodSchema(() => z.strictObject({
  readyCount: z.number().check(z.int(), z.nonnegative()),
  pendingCount: z.number().check(z.int(), z.nonnegative()),
  unavailableCounts: z.strictObject({
    plain_account: z.number().check(z.int(), z.nonnegative()),
    encryption_setup_required: z.number().check(z.int(), z.nonnegative()),
    encryption_inconsistent: z.number().check(z.int(), z.nonnegative()),
  }),
}));
export type TaskRecipientReadinessV1 = z.infer<typeof TaskRecipientReadinessV1Schema>;
export const TaskAccessGrantRowV1Schema = lazyZodSchema(() => z.extend(ResourceAccessGrantRowV1Schema, {
  readiness: z.optional(TaskRecipientReadinessV1Schema),
}));
export type TaskAccessGrantRowV1 = z.infer<typeof TaskAccessGrantRowV1Schema>;
export const TaskAccessGrantsListResponseV1Schema = lazyZodSchema(() => z.extend(TaskResourceAddressV1Schema, {
  access: ResourceCallerAccessV1Schema, grants: z.array(TaskAccessGrantRowV1Schema), ownerDisplayName,
}));
export type TaskAccessGrantsListResponseV1 = z.infer<typeof TaskAccessGrantsListResponseV1Schema>;
export const TaskAccessGrantMutationResponseV1Schema = lazyZodSchema(() => z.strictObject({ changed: z.boolean() }));
export type TaskAccessGrantMutationResponseV1 = z.infer<typeof TaskAccessGrantMutationResponseV1Schema>;
export const TaskAccessRecipientCensusRequestV1Schema = lazyZodSchema(() => z.strictObject({ principal: z.optional(PrincipalRefV1Schema) }));
export type TaskAccessRecipientCensusRequestV1 = z.infer<typeof TaskAccessRecipientCensusRequestV1Schema>;
export const TaskAccessRecipientCensusResponseV1Schema = lazyZodSchema(() => z.extend(ResourceAccessRecipientCensusV1Schema, {
  taskId: z.string().check(z.minLength(1)),
}));
export type TaskAccessRecipientCensusResponseV1 = z.infer<typeof TaskAccessRecipientCensusResponseV1Schema>;
export const TaskRecipientKeyEnvelopeCommitInputV1Schema = ResourceRecipientKeyEnvelopeCommitInputV1Schema;
export type TaskRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof TaskRecipientKeyEnvelopeCommitInputV1Schema>;
export const TaskRecipientKeyEnvelopeCommitResponseV1Schema = ResourceRecipientKeyEnvelopeCommitResponseV1Schema;
export type TaskRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof TaskRecipientKeyEnvelopeCommitResponseV1Schema>;
export const TaskResourceErrorV1Schema = lazyZodSchema(() => z.enum([
  'task_not_found', 'task_content_unavailable', 'task_version_conflict', 'task_encryption_mode_mismatch', 'task_invalid_content',
  'task_promotion_required', 'task_access_forbidden', 'task_owner_grant_invalid', 'task_subject_not_found',
  'task_subject_ineligible', 'task_invalid_recipient_envelope', 'task_data_key_changed',
]));
export type TaskResourceErrorV1 = z.infer<typeof TaskResourceErrorV1Schema>;
export const TaskResourceErrorResponseV1Schema = lazyZodSchema(() => z.strictObject({ error: TaskResourceErrorV1Schema }));
