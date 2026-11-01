import { z } from 'zod';

import { V2SessionListResponseSchema, type V2SessionListResponse } from '../sessionControl/contract.js';
import {
  SessionFolderAssignmentMutationResultSchema as CanonicalSessionFolderAssignmentMutationResultSchema,
  SessionFolderAssignmentSchema as CanonicalSessionFolderAssignmentSchema,
} from '../sessionOrganization/folders.js';
import {
  MoveSessionFolderAssignmentsRequestSchema as CanonicalMoveSessionFolderAssignmentsRequestSchema,
  MoveSessionFolderAssignmentsResponseSchema as CanonicalMoveSessionFolderAssignmentsResponseSchema,
  SessionFolderAssignmentListRequestSchema as CanonicalSessionFolderAssignmentListRequestSchema,
  SessionFolderAssignmentListResponseSchema as CanonicalSessionFolderAssignmentListResponseSchema,
  SetSessionFolderAssignmentRequestSchema as CanonicalSetSessionFolderAssignmentRequestSchema,
  SetSessionFolderAssignmentResponseSchema as CanonicalSetSessionFolderAssignmentResponseSchema,
} from '../sessionOrganization/mutations.js';
import { SESSION_FOLDER_MAX_ID_LENGTH } from './folderSettings.js';
import { lazySchema } from '../lazySchema.js';

export const SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_FOLDER_IDS = 100;
export const SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_SESSION_IDS = 500;
export const SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_LIMIT = 200;

const SessionFolderIdSchema = lazySchema(() => z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH));

export const SessionFolderAssignmentSchema = CanonicalSessionFolderAssignmentSchema;
export type SessionFolderAssignment = z.infer<typeof SessionFolderAssignmentSchema>;

export const SessionFolderAssignmentMutationResultSchema = CanonicalSessionFolderAssignmentMutationResultSchema;
export type SessionFolderAssignmentMutationResult = z.infer<typeof SessionFolderAssignmentMutationResultSchema>;

export const SessionFolderAssignmentListRequestSchema = CanonicalSessionFolderAssignmentListRequestSchema;
export type SessionFolderAssignmentListRequest = z.infer<typeof SessionFolderAssignmentListRequestSchema>;

export const SessionFolderAssignmentListResponseSchema = CanonicalSessionFolderAssignmentListResponseSchema;
export type SessionFolderAssignmentListResponse = z.infer<typeof SessionFolderAssignmentListResponseSchema>;

export const SetSessionFolderAssignmentRequestSchema = CanonicalSetSessionFolderAssignmentRequestSchema;
export type SetSessionFolderAssignmentRequest = z.infer<typeof SetSessionFolderAssignmentRequestSchema>;

export const SetSessionFolderAssignmentResponseSchema = CanonicalSetSessionFolderAssignmentResponseSchema;
export type SetSessionFolderAssignmentResponse = z.infer<typeof SetSessionFolderAssignmentResponseSchema>;

export const QuerySessionFolderSessionsRequestSchema = lazySchema(() => z
  .object({
    folderIds: z.array(SessionFolderIdSchema).min(1).max(SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_FOLDER_IDS),
    cursor: z.string().trim().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_LIMIT).optional(),
    archived: z.boolean().optional(),
  })
  .strict());
export type QuerySessionFolderSessionsRequest = z.infer<typeof QuerySessionFolderSessionsRequestSchema>;

export const QuerySessionFolderSessionsResponseSchema = V2SessionListResponseSchema;
export type QuerySessionFolderSessionsResponse = V2SessionListResponse;

export const MoveSessionFolderAssignmentsRequestSchema = CanonicalMoveSessionFolderAssignmentsRequestSchema;
export type MoveSessionFolderAssignmentsRequest = z.infer<typeof MoveSessionFolderAssignmentsRequestSchema>;

export const MoveSessionFolderAssignmentsResponseSchema = CanonicalMoveSessionFolderAssignmentsResponseSchema;
export type MoveSessionFolderAssignmentsResponse = z.infer<typeof MoveSessionFolderAssignmentsResponseSchema>;
