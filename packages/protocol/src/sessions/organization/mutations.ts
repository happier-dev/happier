import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

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
import { SessionOrganizationContentEnvelopeSchema } from './contentSchemas.js';
import {
  SessionFolderAssignmentMutationResultSchema,
  SessionFolderAssignmentSchema,
  SessionOrganizationFolderSchema,
} from './folders.js';
import { SessionOrganizationOrderEntrySchema, SessionOrganizationOrderItemKindSchema, SessionOrganizationOrderScopeKindSchema } from './ordering.js';
import { SessionOrganizationLabelKindSchema, SessionOrganizationLabelSchema } from './ordering.js';
import { SessionOrganizationPinSchema, SessionOrganizationPinSurfaceSchema } from './pins.js';
import { SessionOrganizationTagSchema, SessionTagAssignmentSchema } from './tags.js';

const SessionOrganizationIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH)));

export const SetSessionPinRequestSchema = lazyZodSchema(() => z.strictObject({
    pinned: z.boolean(),
    surface: z.optional(SessionOrganizationPinSurfaceSchema),
    sortKey: z.optional(z.nullable(SessionOrganizationSortKeySchema)),
  }));
export type SetSessionPinRequest = z.infer<typeof SetSessionPinRequestSchema>;

export const SetSessionPinResponseSchema = lazyZodSchema(() => z.strictObject({
    pin: z.nullable(SessionOrganizationPinSchema),
  }));
export type SetSessionPinResponse = z.infer<typeof SetSessionPinResponseSchema>;

const ReorderSessionOrganizationEntrySchema = lazyZodSchema(() => z.strictObject({
    itemKind: SessionOrganizationOrderItemKindSchema,
    itemKey: SessionOrganizationKeySchema,
    sortKey: SessionOrganizationSortKeySchema,
  }));

export const ReorderSessionOrganizationRequestSchema = lazyZodSchema(() => z.strictObject({
    scopeKind: SessionOrganizationOrderScopeKindSchema,
    scopeKey: SessionOrganizationKeySchema,
    entries: z.array(ReorderSessionOrganizationEntrySchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_ORDER_ENTRIES_PER_SCOPE)),
  }));
export type ReorderSessionOrganizationRequest = z.infer<typeof ReorderSessionOrganizationRequestSchema>;

export const ReorderSessionOrganizationResponseSchema = lazyZodSchema(() => z.strictObject({
    orderEntries: z.array(SessionOrganizationOrderEntrySchema),
  }));
export type ReorderSessionOrganizationResponse = z.infer<typeof ReorderSessionOrganizationResponseSchema>;

export const CreateOrUpdateSessionOrganizationFolderRequestSchema = lazyZodSchema(() => z.strictObject({
    folderId: z.optional(SessionOrganizationIdSchema),
    folderKey: SessionOrganizationKeySchema,
    parentFolderId: z.nullable(SessionOrganizationIdSchema),
    parentFolderKey: z.nullable(SessionOrganizationKeySchema),
    sortKey: z.nullable(SessionOrganizationSortKeySchema),
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
  }));
export type CreateOrUpdateSessionOrganizationFolderRequest = z.infer<typeof CreateOrUpdateSessionOrganizationFolderRequestSchema>;

export const CreateOrUpdateSessionOrganizationFolderResponseSchema = lazyZodSchema(() => z.strictObject({
    folder: SessionOrganizationFolderSchema,
  }));
export type CreateOrUpdateSessionOrganizationFolderResponse = z.infer<typeof CreateOrUpdateSessionOrganizationFolderResponseSchema>;

export const DeleteSessionOrganizationFolderRequestSchema = lazyZodSchema(() => z.strictObject({
    folderId: SessionOrganizationIdSchema,
    assignmentBehavior: z._default(z.enum(SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENT_BEHAVIORS), SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT),
  }));
export type DeleteSessionOrganizationFolderRequest = z.infer<typeof DeleteSessionOrganizationFolderRequestSchema>;

export const DeleteSessionOrganizationFolderResponseSchema = lazyZodSchema(() => z.strictObject({
    deletedFolderIds: z.array(SessionOrganizationIdSchema),
    assignmentTargetFolderId: z.nullable(SessionOrganizationIdSchema),
    affectedAssignmentCount: z.number().check(z.int(), z.nonnegative()),
  }));
export type DeleteSessionOrganizationFolderResponse = z.infer<typeof DeleteSessionOrganizationFolderResponseSchema>;

export const SetSessionFolderAssignmentRequestSchema = lazyZodSchema(() => z.strictObject({
    folderId: z.nullable(SessionOrganizationIdSchema),
  }));
export type SetSessionFolderAssignmentRequest = z.infer<typeof SetSessionFolderAssignmentRequestSchema>;

export const SetSessionFolderAssignmentResponseSchema = SessionFolderAssignmentMutationResultSchema;
export type SetSessionFolderAssignmentResponse = z.infer<typeof SetSessionFolderAssignmentResponseSchema>;

export const MoveSessionFolderAssignmentsRequestSchema = lazyZodSchema(() => z.strictObject({
    fromFolderIds: z.array(SessionOrganizationIdSchema).check(z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION)),
    toFolderId: z.nullable(SessionOrganizationIdSchema),
  }));
export type MoveSessionFolderAssignmentsRequest = z.infer<typeof MoveSessionFolderAssignmentsRequestSchema>;

export const MoveSessionFolderAssignmentsResponseSchema = lazyZodSchema(() => z.strictObject({
    assignments: z.array(SessionFolderAssignmentMutationResultSchema),
    affectedCount: z.number().check(z.int(), z.nonnegative()),
    toFolderId: z.nullable(SessionOrganizationIdSchema),
  }));
export type MoveSessionFolderAssignmentsResponse = z.infer<typeof MoveSessionFolderAssignmentsResponseSchema>;

export const SessionFolderAssignmentListRequestSchema = lazyZodSchema(() => z.strictObject({
    sessionIds: z.array(SessionOrganizationIdSchema).check(z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION)),
  }));
export type SessionFolderAssignmentListRequest = z.infer<typeof SessionFolderAssignmentListRequestSchema>;

export const SessionFolderAssignmentListResponseSchema = lazyZodSchema(() => z.strictObject({
    assignments: z.array(SessionFolderAssignmentSchema),
  }));
export type SessionFolderAssignmentListResponse = z.infer<typeof SessionFolderAssignmentListResponseSchema>;

export const CreateOrUpdateSessionOrganizationTagRequestSchema = lazyZodSchema(() => z.strictObject({
    tagId: z.optional(SessionOrganizationIdSchema),
    tagKey: SessionOrganizationKeySchema,
    sortKey: z.nullable(SessionOrganizationSortKeySchema),
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
  }));
export type CreateOrUpdateSessionOrganizationTagRequest = z.infer<typeof CreateOrUpdateSessionOrganizationTagRequestSchema>;

export const CreateOrUpdateSessionOrganizationTagResponseSchema = lazyZodSchema(() => z.strictObject({
    tag: SessionOrganizationTagSchema,
  }));
export type CreateOrUpdateSessionOrganizationTagResponse = z.infer<typeof CreateOrUpdateSessionOrganizationTagResponseSchema>;

export const DeleteSessionOrganizationTagRequestSchema = lazyZodSchema(() => z.strictObject({
    tagId: SessionOrganizationIdSchema,
    assignmentBehavior: z._default(z.enum(SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENT_BEHAVIORS), SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT),
  }));
export type DeleteSessionOrganizationTagRequest = z.infer<typeof DeleteSessionOrganizationTagRequestSchema>;

export const DeleteSessionOrganizationTagResponseSchema = lazyZodSchema(() => z.strictObject({
    tagId: SessionOrganizationIdSchema,
    removedAssignmentCount: z.number().check(z.int(), z.nonnegative()),
  }));
export type DeleteSessionOrganizationTagResponse = z.infer<typeof DeleteSessionOrganizationTagResponseSchema>;

export const SetSessionTagAssignmentsRequestSchema = lazyZodSchema(() => z.strictObject({
    tagIds: z.array(SessionOrganizationIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION)),
  }));
export type SetSessionTagAssignmentsRequest = z.infer<typeof SetSessionTagAssignmentsRequestSchema>;

/** Delta writes preserve assignments the caller did not edit, including private memberships. */
export const PatchSessionTagAssignmentsRequestSchema = lazyZodSchema(() => z.strictObject({
    addTagIds: z.array(SessionOrganizationIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION)),
    removeTagIds: z.array(SessionOrganizationIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION)),
}));
export const MutateSessionTagAssignmentsRequestSchema = lazyZodSchema(() => z.union([
    SetSessionTagAssignmentsRequestSchema, PatchSessionTagAssignmentsRequestSchema,
]));
export type MutateSessionTagAssignmentsRequest = z.infer<typeof MutateSessionTagAssignmentsRequestSchema>;

export const SetSessionTagAssignmentsResponseSchema = SessionTagAssignmentSchema;
export type SetSessionTagAssignmentsResponse = z.infer<typeof SetSessionTagAssignmentsResponseSchema>;

export const UpsertSessionOrganizationLabelRequestSchema = lazyZodSchema(() => z.strictObject({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationKeySchema,
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
  }));
export type UpsertSessionOrganizationLabelRequest = z.infer<typeof UpsertSessionOrganizationLabelRequestSchema>;

export const UpsertSessionOrganizationLabelResponseSchema = lazyZodSchema(() => z.strictObject({
    label: SessionOrganizationLabelSchema,
  }));
export type UpsertSessionOrganizationLabelResponse = z.infer<typeof UpsertSessionOrganizationLabelResponseSchema>;

export const DeleteSessionOrganizationLabelRequestSchema = lazyZodSchema(() => z.strictObject({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationKeySchema,
  }));
export type DeleteSessionOrganizationLabelRequest = z.infer<typeof DeleteSessionOrganizationLabelRequestSchema>;

export const DeleteSessionOrganizationLabelResponseSchema = lazyZodSchema(() => z.strictObject({
    labelKind: SessionOrganizationLabelKindSchema,
    scopeKey: SessionOrganizationKeySchema,
    archived: z.boolean(),
  }));
export type DeleteSessionOrganizationLabelResponse = z.infer<typeof DeleteSessionOrganizationLabelResponseSchema>;

const ImportLegacySessionOrganizationPinSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationIdSchema,
    sortKey: z.optional(z.nullable(SessionOrganizationSortKeySchema)),
  }));

export const ImportLegacySessionOrganizationRequestSchema = lazyZodSchema(() => z.strictObject({
    pins: z._default(z.array(ImportLegacySessionOrganizationPinSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_PINNED_SESSIONS)), []),
    folders: z._default(z.array(CreateOrUpdateSessionOrganizationFolderRequestSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_FOLDERS)), []),
    tags: z._default(z.array(CreateOrUpdateSessionOrganizationTagRequestSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_TAGS)), []),
    tagAssignments: z._default(z.array(SessionTagAssignmentSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION)), []),
    orderEntries: z._default(z.array(SessionOrganizationOrderEntrySchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_ORDER_ENTRIES_PER_SCOPE)), []),
    labels: z._default(z.array(UpsertSessionOrganizationLabelRequestSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_LABELS)), []),
  }));
export type ImportLegacySessionOrganizationRequest = z.infer<typeof ImportLegacySessionOrganizationRequestSchema>;

export const ImportLegacySessionOrganizationResponseSchema = lazyZodSchema(() => z.strictObject({
    imported: z.strictObject({
        pins: z.number().check(z.int(), z.nonnegative()),
        folders: z.number().check(z.int(), z.nonnegative()),
        tags: z.number().check(z.int(), z.nonnegative()),
        orderEntries: z.number().check(z.int(), z.nonnegative()),
        labels: z.number().check(z.int(), z.nonnegative()),
      }),
  }));
export type ImportLegacySessionOrganizationResponse = z.infer<typeof ImportLegacySessionOrganizationResponseSchema>;
