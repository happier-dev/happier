import { z } from 'zod';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';
import { SessionOrganizationContentEnvelopeSchema } from './content.js';
import { lazySchema } from '../lazySchema.js';

const SessionOrganizationFolderIdSchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationFolderKeySchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH));
const SessionOrganizationSessionIdSchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationSortKeySchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH));

export const SessionOrganizationFolderSchema = lazySchema(() => z
  .object({
    folderId: SessionOrganizationFolderIdSchema,
    folderKey: SessionOrganizationFolderKeySchema,
    parentFolderId: SessionOrganizationFolderIdSchema.nullable(),
    parentFolderKey: SessionOrganizationFolderKeySchema.nullable(),
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
    archivedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionOrganizationFolder = z.infer<typeof SessionOrganizationFolderSchema>;

export const SessionFolderAssignmentSchema = lazySchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: SessionOrganizationFolderIdSchema,
  })
  .strict());
export type SessionFolderAssignment = z.infer<typeof SessionFolderAssignmentSchema>;

export const SessionFolderAssignmentMutationResultSchema = lazySchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: SessionOrganizationFolderIdSchema.nullable(),
  })
  .strict());
export type SessionFolderAssignmentMutationResult = z.infer<typeof SessionFolderAssignmentMutationResultSchema>;
