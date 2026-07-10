import { z } from 'zod';

export const SESSION_FOLDER_MAX_COUNT = 500;
export const SESSION_FOLDER_MAX_DEPTH = 8;
export const SESSION_FOLDER_MAX_NAME_LENGTH = 80;
export const SESSION_FOLDER_VISUAL_DEPTH_CAP = 3;
export const SESSION_FOLDER_MAX_ID_LENGTH = 2_000;
export const SESSION_FOLDER_MAX_PATH_LENGTH = 10_000;

const FolderIdSchema = z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH);
const OptionalRenderWorkspaceKeySchema = z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH).optional();
const ServerIdSchema = z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH).nullable();

const SessionFolderWorkspaceRefWorkspaceRefV1Schema = z
  .object({
    t: z.literal('workspaceRef'),
    serverId: ServerIdSchema,
    workspaceRefId: z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH),
  })
  .strict();

const SessionFolderWorkspaceRefWorkspaceScopeV1Schema = z
  .object({
    t: z.literal('workspaceScope'),
    serverId: ServerIdSchema,
    machineId: z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH).nullable(),
    rootPath: z.string().trim().min(1).max(SESSION_FOLDER_MAX_PATH_LENGTH),
  })
  .strict();

export const SessionFolderWorkspaceRefV1Schema = z.discriminatedUnion('t', [
  SessionFolderWorkspaceRefWorkspaceRefV1Schema,
  SessionFolderWorkspaceRefWorkspaceScopeV1Schema,
]);
export type SessionFolderWorkspaceRefV1 = z.infer<typeof SessionFolderWorkspaceRefV1Schema>;

export const SessionFolderV1Schema = z
  .object({
    id: FolderIdSchema,
    workspace: SessionFolderWorkspaceRefV1Schema,
    renderWorkspaceKey: OptionalRenderWorkspaceKeySchema,
    parentId: FolderIdSchema.nullable(),
    name: z.string().trim().min(1).max(SESSION_FOLDER_MAX_NAME_LENGTH),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    sortKey: z.string().trim().min(1).max(SESSION_FOLDER_MAX_ID_LENGTH).optional(),
  })
  .strict();
export type SessionFolderV1 = z.infer<typeof SessionFolderV1Schema>;

export const SessionFoldersV1Schema = z
  .object({
    v: z.literal(1),
    folders: z.array(SessionFolderV1Schema).max(SESSION_FOLDER_MAX_COUNT).default([]),
  })
  .strict();
export type SessionFoldersV1 = z.infer<typeof SessionFoldersV1Schema>;

export const DefaultSessionFoldersV1: SessionFoldersV1 = {
  v: 1,
  folders: [],
};
