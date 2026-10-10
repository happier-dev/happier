import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';
import {
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationDisplayStateSchema,
} from './contentSchemas.js';

const SessionOrganizationFolderIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationFolderKeySchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH));
const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH));

export const SessionOrganizationFolderSchema = lazyZodSchema(() => z
  .object({
    folderId: SessionOrganizationFolderIdSchema,
    folderKey: SessionOrganizationFolderKeySchema,
    parentFolderId: SessionOrganizationFolderIdSchema.nullable(),
    parentFolderKey: SessionOrganizationFolderKeySchema.nullable(),
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
    displayState: SessionOrganizationDisplayStateSchema.optional(),
    archivedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionOrganizationFolder = z.infer<typeof SessionOrganizationFolderSchema>;

export const SessionFolderAssignmentSchema = lazyZodSchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: SessionOrganizationFolderIdSchema,
  })
  .strict());
export type SessionFolderAssignment = z.infer<typeof SessionFolderAssignmentSchema>;

export const SessionFolderAssignmentMutationResultSchema = lazyZodSchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: SessionOrganizationFolderIdSchema.nullable(),
  })
  .strict());
export type SessionFolderAssignmentMutationResult = z.infer<typeof SessionFolderAssignmentMutationResultSchema>;
