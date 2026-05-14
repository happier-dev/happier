import { z } from 'zod';

import { V2SessionListResponseSchema, type V2SessionListResponse } from '../sessionControl/contract.js';
import { SESSION_FOLDER_MAX_ID_LENGTH } from './folderSettings.js';

export const SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_FOLDER_IDS = 100;
export const SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_SESSION_IDS = 500;
export const SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_LIMIT = 200;

const SessionFolderIdSchema = z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH);
const SessionIdSchema = z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH);

export const SessionFolderAssignmentSchema = z
  .object({
    sessionId: SessionIdSchema,
    folderId: SessionFolderIdSchema,
  })
  .strict();
export type SessionFolderAssignment = z.infer<typeof SessionFolderAssignmentSchema>;

export const SessionFolderAssignmentMutationResultSchema = z
  .object({
    sessionId: SessionIdSchema,
    folderId: SessionFolderIdSchema.nullable(),
  })
  .strict();
export type SessionFolderAssignmentMutationResult = z.infer<typeof SessionFolderAssignmentMutationResultSchema>;

export const SessionFolderAssignmentListRequestSchema = z
  .object({
    sessionIds: z.array(SessionIdSchema).min(1).max(SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_SESSION_IDS),
  })
  .strict();
export type SessionFolderAssignmentListRequest = z.infer<typeof SessionFolderAssignmentListRequestSchema>;

export const SessionFolderAssignmentListResponseSchema = z
  .object({
    assignments: z.array(SessionFolderAssignmentSchema),
  })
  .strict();
export type SessionFolderAssignmentListResponse = z.infer<typeof SessionFolderAssignmentListResponseSchema>;

export const SetSessionFolderAssignmentRequestSchema = z
  .object({
    folderId: SessionFolderIdSchema.nullable(),
  })
  .strict();
export type SetSessionFolderAssignmentRequest = z.infer<typeof SetSessionFolderAssignmentRequestSchema>;

export const SetSessionFolderAssignmentResponseSchema = SessionFolderAssignmentMutationResultSchema;
export type SetSessionFolderAssignmentResponse = z.infer<typeof SetSessionFolderAssignmentResponseSchema>;

export const QuerySessionFolderSessionsRequestSchema = z
  .object({
    folderIds: z.array(SessionFolderIdSchema).min(1).max(SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_FOLDER_IDS),
    cursor: z.string().trim().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_LIMIT).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type QuerySessionFolderSessionsRequest = z.infer<typeof QuerySessionFolderSessionsRequestSchema>;

export const QuerySessionFolderSessionsResponseSchema = V2SessionListResponseSchema;
export type QuerySessionFolderSessionsResponse = V2SessionListResponse;

export const MoveSessionFolderAssignmentsRequestSchema = z
  .object({
    fromFolderIds: z.array(SessionFolderIdSchema).min(1).max(SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_FOLDER_IDS),
    toFolderId: SessionFolderIdSchema.nullable(),
  })
  .strict();
export type MoveSessionFolderAssignmentsRequest = z.infer<typeof MoveSessionFolderAssignmentsRequestSchema>;

export const MoveSessionFolderAssignmentsResponseSchema = z
  .object({
    assignments: z.array(SessionFolderAssignmentMutationResultSchema),
    affectedCount: z.number().int().min(0),
    toFolderId: SessionFolderIdSchema.nullable(),
  })
  .strict();
export type MoveSessionFolderAssignmentsResponse = z.infer<typeof MoveSessionFolderAssignmentsResponseSchema>;
