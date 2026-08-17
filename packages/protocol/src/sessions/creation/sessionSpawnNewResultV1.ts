import { z } from 'zod';

import { SessionInputAdmissionRejectionCodeV1Schema } from '../messages/sessionInputAdmission.js';
import {
  SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION,
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
} from '../organization/constants.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

const OpaqueSessionCreationIdSchema = z.string()
  .trim()
  .min(1)
  .max(SESSION_ORGANIZATION_MAX_ID_LENGTH);

/**
 * The server-qualified daemon target selected before Session creation. Display
 * labels and host names are intentionally not part of this identity.
 */
export const SessionExecutionTargetV1Schema = z.object({
  serverId: OpaqueSessionCreationIdSchema,
  machineId: OpaqueSessionCreationIdSchema,
}).strict();
export type SessionExecutionTargetV1 = z.infer<typeof SessionExecutionTargetV1Schema>;

/**
 * Creation-time Account organization intent. Existing Session organization
 * edits are a separate domain and must not be inferred from this snapshot.
 */
export const SessionOrganizationPlacementV1Schema = z.object({
  folderId: OpaqueSessionCreationIdSchema.nullable(),
  tagIds: z.array(OpaqueSessionCreationIdSchema)
    .max(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, tagId] of value.tagIds.entries()) {
    if (seen.has(tagId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tagIds', index],
        message: 'Organization placement tag ids must be unique.',
      });
    }
    seen.add(tagId);
  }
});
export type SessionOrganizationPlacementV1 = z.infer<typeof SessionOrganizationPlacementV1Schema>;

export const SessionSpawnNewInitialInputDispositionV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('notRequested') }).strict(),
  z.object({
    status: z.literal('accepted'),
    localId: PendingLocalIdSchema,
  }).strict(),
  z.object({
    status: z.literal('alreadyAccepted'),
    localId: PendingLocalIdSchema,
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: SessionInputAdmissionRejectionCodeV1Schema,
  }).strict(),
  z.object({
    status: z.literal('outcomeUnknown'),
    localId: PendingLocalIdSchema,
    code: z.string().trim().min(1).max(128),
  }).strict(),
]);
export type SessionSpawnNewInitialInputDispositionV1 = z.infer<
  typeof SessionSpawnNewInitialInputDispositionV1Schema
>;

const SessionSpawnNewErrorCodeV1Schema = z.enum([
  'invalid_input',
  'target_required',
  'target_unavailable',
  'machine_offline',
  'incompatible_target',
  'organization_unavailable',
  'organization_invalid',
  'creation_conflict',
  'permission_denied',
  'cancelled',
  'spawn_failed',
]);
export type SessionSpawnNewErrorCodeV1 = z.infer<typeof SessionSpawnNewErrorCodeV1Schema>;

/**
 * Public Session creation settlement. Once a Session id exists, optional
 * initial-input admission stays nested so callers cannot mistake a rejected
 * input for a failed Session create.
 */
export const SessionSpawnNewResultV1Schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('success'),
    disposition: z.enum(['created', 'rejoined']),
    sessionId: asProtocolZod(SessionIdSchema),
    executionTarget: SessionExecutionTargetV1Schema,
    organizationPlacement: SessionOrganizationPlacementV1Schema,
    initialInput: SessionSpawnNewInitialInputDispositionV1Schema,
  }).strict(),
  z.object({
    type: z.literal('pending'),
    retryWithSameCreationKey: z.literal(true),
    outcome: z.enum(['accepted', 'unknown']),
  }).strict(),
  z.object({
    type: z.literal('error'),
    code: SessionSpawnNewErrorCodeV1Schema,
    retryable: z.boolean(),
  }).strict(),
]);
export type SessionSpawnNewResultV1 = z.infer<typeof SessionSpawnNewResultV1Schema>;
