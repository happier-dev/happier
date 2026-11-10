import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

export const SESSION_FOLDER_MAX_COUNT = 500;
export const SESSION_FOLDER_MAX_DEPTH = 8;
export const SESSION_FOLDER_MAX_NAME_LENGTH = 80;
export const SESSION_FOLDER_VISUAL_DEPTH_CAP = 3;
export const SESSION_FOLDER_MAX_ID_LENGTH = 2_000;
export const SESSION_FOLDER_MAX_PATH_LENGTH = 10_000;

const FolderIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_ID_LENGTH));
const OptionalRenderWorkspaceKeySchema = z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_ID_LENGTH)));
const ServerIdSchema = z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_ID_LENGTH)));

const SessionFolderWorkspaceRefWorkspaceRefV1Schema = z.strictObject({
    t: z.literal('workspaceRef'),
    serverId: ServerIdSchema,
    workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_ID_LENGTH)),
  });

const SessionFolderWorkspaceRefWorkspaceScopeV1Schema = z.strictObject({
    t: z.literal('workspaceScope'),
    serverId: ServerIdSchema,
    machineId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_ID_LENGTH))),
    rootPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_PATH_LENGTH)),
  });

export const SessionFolderWorkspaceRefV1Schema = z.discriminatedUnion('t', [
  SessionFolderWorkspaceRefWorkspaceRefV1Schema,
  SessionFolderWorkspaceRefWorkspaceScopeV1Schema,
  z.strictObject({
    t: z.literal('managedSessions'),
    serverId: ServerIdSchema,
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_ID_LENGTH)),
  }),
]);
export type SessionFolderWorkspaceRefV1 = z.infer<typeof SessionFolderWorkspaceRefV1Schema>;
export const SessionFolderWorkspaceRefV1StoredSchema = createStoredReadSchema(SessionFolderWorkspaceRefV1Schema);

export const SessionFolderV1Schema = z.strictObject({
    id: FolderIdSchema,
    workspace: SessionFolderWorkspaceRefV1Schema,
    renderWorkspaceKey: OptionalRenderWorkspaceKeySchema,
    parentId: z.nullable(FolderIdSchema),
    name: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_NAME_LENGTH)),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    sortKey: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_FOLDER_MAX_ID_LENGTH))),
  });
export type SessionFolderV1 = z.infer<typeof SessionFolderV1Schema>;

export const SessionFoldersV1Schema = z.strictObject({
    v: z.literal(1),
    folders: z._default(z.array(SessionFolderV1Schema).check(z.maxLength(SESSION_FOLDER_MAX_COUNT)), []),
  });
export type SessionFoldersV1 = z.infer<typeof SessionFoldersV1Schema>;
export const SessionFoldersV1StoredSchema = createStoredReadSchema(SessionFoldersV1Schema);

export const DefaultSessionFoldersV1: SessionFoldersV1 = {
  v: 1,
  folders: [],
};
