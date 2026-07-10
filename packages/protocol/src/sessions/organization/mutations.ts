import { z } from 'zod';

import {
  SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENT_BEHAVIORS,
  SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT,
  SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION,
  SESSION_ORGANIZATION_MAX_FOLDERS,
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_LABELS,
  SESSION_ORGANIZATION_MAX_ORDER_ENTRIES_PER_SCOPE,
  SESSION_ORGANIZATION_MAX_PINNED_SESSIONS,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_TAGS,
  SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENT_BEHAVIORS,
  SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT,
} from './constants.js';
import { SessionOrganizationContentEnvelopeSchema } from './content.js';
import {
  SessionFolderAssignmentMutationResultSchema,
  SessionFolderAssignmentSchema,
  SessionOrganizationFolderSchema,
} from './folders.js';
import { SessionOrganizationOrderEntrySchema, SessionOrganizationOrderItemKindSchema, SessionOrganizationOrderScopeKindSchema } from './ordering.js';
import { SessionOrganizationLabelKindSchema, SessionOrganizationLabelSchema } from './ordering.js';
import { SessionOrganizationPinSchema } from './pins.js';
import { SessionOrganizationTagSchema, SessionTagAssignmentSchema } from './tags.js';

const SessionOrganizationIdSchema = z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH);
const SessionOrganizationKeySchema = z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH);
const SessionOrganizationSortKeySchema = z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH);

export const SetSessionPinRequestSchema = z
  .object({
    pinned: z.boolean(),
    sortKey: SessionOrganizationSortKeySchema.nullable().optional(),
  })
  .strict();
export type SetSessionPinRequest = z.infer<typeof SetSessionPinRequestSchema>;

export const SetSessionPinResponseSchema = z
  .object({
    pin: SessionOrganizationPinSchema.nullable(),
  })
  .strict();
export type SetSessionPinResponse = z.infer<typeof SetSessionPinResponseSchema>;

const ReorderSessionOrganizationEntrySchema = z
  .object({
    itemKind: SessionOrganizationOrderItemKindSchema,
    itemKey: SessionOrganizationKeySchema,
    sortKey: SessionOrganizationSortKeySchema,
  })
  .strict();

export const ReorderSessionOrganizationRequestSchema = z
  .object({
    scopeKind: SessionOrganizationOrderScopeKindSchema,
    scopeKey: SessionOrganizationKeySchema,
    entries: z.array(ReorderSessionOrganizationEntrySchema).max(SESSION_ORGANIZATION_MAX_ORDER_ENTRIES_PER_SCOPE),
  })
  .strict();
export type ReorderSessionOrganizationRequest = z.infer<typeof ReorderSessionOrganizationRequestSchema>;

export const ReorderSessionOrganizationResponseSchema = z
  .object({
    orderEntries: z.array(SessionOrganizationOrderEntrySchema),
  })
  .strict();
export type ReorderSessionOrganizationResponse = z.infer<typeof ReorderSessionOrganizationResponseSchema>;

export const CreateOrUpdateSessionOrganizationFolderRequestSchema = z
  .object({
    folderId: SessionOrganizationIdSchema.optional(),
    folderKey: SessionOrganizationKeySchema,
    parentFolderId: SessionOrganizationIdSchema.nullable(),
    parentFolderKey: SessionOrganizationKeySchema.nullable(),
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
  })
  .strict();
export type CreateOrUpdateSessionOrganizationFolderRequest = z.infer<typeof CreateOrUpdateSessionOrganizationFolderRequestSchema>;

export const CreateOrUpdateSessionOrganizationFolderResponseSchema = z
  .object({
    folder: SessionOrganizationFolderSchema,
  })
  .strict();
export type CreateOrUpdateSessionOrganizationFolderResponse = z.infer<typeof CreateOrUpdateSessionOrganizationFolderResponseSchema>;

export const DeleteSessionOrganizationFolderRequestSchema = z
  .object({
    folderId: SessionOrganizationIdSchema,
    assignmentBehavior: z.enum(SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENT_BEHAVIORS).default(SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT),
  })
  .strict();
export type DeleteSessionOrganizationFolderRequest = z.infer<typeof DeleteSessionOrganizationFolderRequestSchema>;

export const DeleteSessionOrganizationFolderResponseSchema = z
  .object({
    deletedFolderIds: z.array(SessionOrganizationIdSchema),
    assignmentTargetFolderId: SessionOrganizationIdSchema.nullable(),
    affectedAssignmentCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteSessionOrganizationFolderResponse = z.infer<typeof DeleteSessionOrganizationFolderResponseSchema>;

export const SetSessionFolderAssignmentRequestSchema = z
  .object({
    folderId: SessionOrganizationIdSchema.nullable(),
  })
  .strict();
export type SetSessionFolderAssignmentRequest = z.infer<typeof SetSessionFolderAssignmentRequestSchema>;

export const SetSessionFolderAssignmentResponseSchema = SessionFolderAssignmentMutationResultSchema;
export type SetSessionFolderAssignmentResponse = z.infer<typeof SetSessionFolderAssignmentResponseSchema>;

export const MoveSessionFolderAssignmentsRequestSchema = z
  .object({
    fromFolderIds: z.array(SessionOrganizationIdSchema).min(1).max(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION),
    toFolderId: SessionOrganizationIdSchema.nullable(),
  })
  .strict();
export type MoveSessionFolderAssignmentsRequest = z.infer<typeof MoveSessionFolderAssignmentsRequestSchema>;

export const MoveSessionFolderAssignmentsResponseSchema = z
  .object({
    assignments: z.array(SessionFolderAssignmentMutationResultSchema),
    affectedCount: z.number().int().nonnegative(),
    toFolderId: SessionOrganizationIdSchema.nullable(),
  })
  .strict();
export type MoveSessionFolderAssignmentsResponse = z.infer<typeof MoveSessionFolderAssignmentsResponseSchema>;

export const SessionFolderAssignmentListRequestSchema = z
  .object({
    sessionIds: z.array(SessionOrganizationIdSchema).min(1).max(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION),
  })
  .strict();
export type SessionFolderAssignmentListRequest = z.infer<typeof SessionFolderAssignmentListRequestSchema>;

export const SessionFolderAssignmentListResponseSchema = z
  .object({
    assignments: z.array(SessionFolderAssignmentSchema),
  })
  .strict();
export type SessionFolderAssignmentListResponse = z.infer<typeof SessionFolderAssignmentListResponseSchema>;

export const CreateOrUpdateSessionOrganizationTagRequestSchema = z
  .object({
    tagId: SessionOrganizationIdSchema.optional(),
    tagKey: SessionOrganizationKeySchema,
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
  })
  .strict();
export type CreateOrUpdateSessionOrganizationTagRequest = z.infer<typeof CreateOrUpdateSessionOrganizationTagRequestSchema>;

export const CreateOrUpdateSessionOrganizationTagResponseSchema = z
  .object({
    tag: SessionOrganizationTagSchema,
  })
  .strict();
export type CreateOrUpdateSessionOrganizationTagResponse = z.infer<typeof CreateOrUpdateSessionOrganizationTagResponseSchema>;

export const DeleteSessionOrganizationTagRequestSchema = z
  .object({
    tagId: SessionOrganizationIdSchema,
    assignmentBehavior: z.enum(SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENT_BEHAVIORS).default(SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT),
  })
  .strict();
export type DeleteSessionOrganizationTagRequest = z.infer<typeof DeleteSessionOrganizationTagRequestSchema>;

export const DeleteSessionOrganizationTagResponseSchema = z
  .object({
    tagId: SessionOrganizationIdSchema,
    removedAssignmentCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteSessionOrganizationTagResponse = z.infer<typeof DeleteSessionOrganizationTagResponseSchema>;

export const SetSessionTagAssignmentsRequestSchema = z
  .object({
    tagIds: z.array(SessionOrganizationIdSchema).max(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION),
  })
  .strict();
export type SetSessionTagAssignmentsRequest = z.infer<typeof SetSessionTagAssignmentsRequestSchema>;

export const SetSessionTagAssignmentsResponseSchema = SessionTagAssignmentSchema;
export type SetSessionTagAssignmentsResponse = z.infer<typeof SetSessionTagAssignmentsResponseSchema>;

export const UpsertSessionOrganizationLabelRequestSchema = z
  .object({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationKeySchema,
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
  })
  .strict();
export type UpsertSessionOrganizationLabelRequest = z.infer<typeof UpsertSessionOrganizationLabelRequestSchema>;

export const UpsertSessionOrganizationLabelResponseSchema = z
  .object({
    label: SessionOrganizationLabelSchema,
  })
  .strict();
export type UpsertSessionOrganizationLabelResponse = z.infer<typeof UpsertSessionOrganizationLabelResponseSchema>;

export const DeleteSessionOrganizationLabelRequestSchema = z
  .object({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationKeySchema,
  })
  .strict();
export type DeleteSessionOrganizationLabelRequest = z.infer<typeof DeleteSessionOrganizationLabelRequestSchema>;

export const DeleteSessionOrganizationLabelResponseSchema = z
  .object({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationKeySchema,
    archived: z.boolean(),
  })
  .strict();
export type DeleteSessionOrganizationLabelResponse = z.infer<typeof DeleteSessionOrganizationLabelResponseSchema>;

const ImportLegacySessionOrganizationPinSchema = z
  .object({
    sessionId: SessionOrganizationIdSchema,
    sortKey: SessionOrganizationSortKeySchema.nullable().optional(),
  })
  .strict();

export const ImportLegacySessionOrganizationRequestSchema = z
  .object({
    pins: z.array(ImportLegacySessionOrganizationPinSchema).max(SESSION_ORGANIZATION_MAX_PINNED_SESSIONS).default([]),
    folders: z.array(CreateOrUpdateSessionOrganizationFolderRequestSchema).max(SESSION_ORGANIZATION_MAX_FOLDERS).default([]),
    tags: z.array(CreateOrUpdateSessionOrganizationTagRequestSchema).max(SESSION_ORGANIZATION_MAX_TAGS).default([]),
    tagAssignments: z.array(SessionTagAssignmentSchema).max(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION).default([]),
    orderEntries: z.array(SessionOrganizationOrderEntrySchema).max(SESSION_ORGANIZATION_MAX_ORDER_ENTRIES_PER_SCOPE).default([]),
    labels: z.array(UpsertSessionOrganizationLabelRequestSchema).max(SESSION_ORGANIZATION_MAX_LABELS).default([]),
  })
  .strict();
export type ImportLegacySessionOrganizationRequest = z.infer<typeof ImportLegacySessionOrganizationRequestSchema>;

export const ImportLegacySessionOrganizationResponseSchema = z
  .object({
    imported: z
      .object({
        pins: z.number().int().nonnegative(),
        folders: z.number().int().nonnegative(),
        tags: z.number().int().nonnegative(),
        orderEntries: z.number().int().nonnegative(),
        labels: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ImportLegacySessionOrganizationResponse = z.infer<typeof ImportLegacySessionOrganizationResponseSchema>;
