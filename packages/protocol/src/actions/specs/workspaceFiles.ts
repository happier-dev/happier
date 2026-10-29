import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '../../machines/workspaceFiles.js';
import { DaemonWorkspaceFileReplacePreviewRequestSchema, DaemonWorkspaceFileReplacePreviewResponseSchema, DaemonWorkspaceFileReplaceApplyRequestSchema, DaemonWorkspaceFileReplaceApplyResponseSchema, WorkspaceFileReplaceOperationSchema, WorkspaceFileRestoreOperationSchema } from '../../machines/workspaceFiles.js';
import { ActionOperationGetV1RequestSchema } from '../operations/v1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const WorkspaceFilesReplacePreviewActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...DaemonWorkspaceFileReplacePreviewRequestSchema.shape,
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export const WorkspaceFilesReplaceActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...DaemonWorkspaceFileReplaceApplyRequestSchema.shape,
  operation: z.discriminatedUnion('kind', [WorkspaceFileReplaceOperationSchema, WorkspaceFileRestoreOperationSchema]),
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export type WorkspaceFilesReplacePreviewActionInput = z.infer<typeof WorkspaceFilesReplacePreviewActionInputSchema>;
export type WorkspaceFilesReplaceActionInput = z.infer<typeof WorkspaceFilesReplaceActionInputSchema>;
export const WorkspaceFilesReplaceActionOutputSchema = lazyZodSchema(() => z.union([
  DaemonWorkspaceFileReplaceApplyResponseSchema,
  z.strictObject({ operation: ActionOperationGetV1RequestSchema }),
]));

export const WorkspaceFilesSearchActionInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonWorkspaceFileSearchRequestSchema, {
  machineId: z.string().check(z.trim(), z.minLength(1)),
})));

export const WORKSPACE_FILE_ACTION_SPECS = Object.freeze([
  {
    id: 'workspace.files.search', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Search text in workspace files',
    description: 'Search the addressed machine workspace and return one bounded page of grouped text matches with explicit coverage. Refine the query when hasMore is true. Machine and root default to the calling session; supply both for another Machine or outside a session.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_files_search' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { title: 'Search text in workspace files', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'rootPath', title: 'Workspace root', widget: 'text' },
      { path: 'query', title: 'Search text', widget: 'text' },
      { path: 'matchCase', title: 'Match case', widget: 'boolean' },
      { path: 'regex', title: 'Regular expression', widget: 'boolean' },
      { path: 'includeHidden', title: 'Include hidden files', widget: 'boolean' },
    ] },
    inputSchema: WorkspaceFilesSearchActionInputSchema,
    contextualDefaults: { machineId: 'current_session_machine', rootPath: 'current_session_root' },
    outputSchema: DaemonWorkspaceFileSearchResponseSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'workspace.files.replace.preview', executionPlacement: 'machine', approval: { result: 'required' },
    title: 'Preview replacement in workspace files',
    description: 'Review matching text and raw file hashes before applying a single-line replacement. Continue with the returned cursor when hasMore is true. Machine and root default to the calling session; supply both for another Machine or outside a session.',
    contextualDefaults: { machineId: 'current_session_machine', rootPath: 'current_session_root' },
    sideEffectClass: 'read', safety: 'safe', placements: [],
    bindings: { mcpToolName: 'workspace_files_replace_preview', rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: WorkspaceFilesReplacePreviewActionInputSchema,
    outputSchema: DaemonWorkspaceFileReplacePreviewResponseSchema,
    inputHints: { fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'rootPath', title: 'Workspace root', widget: 'text' },
      { path: 'query', title: 'Search text', widget: 'text' },
      { path: 'replacement', title: 'Replacement text', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'workspace.files.replace', executionPlacement: 'machine', approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'direct' },
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'current' } },
    title: 'Replace text in workspace files',
    description: 'Apply a reviewed replacement or restore its inverse edits only when the raw file hashes still match. Machine and root default to the calling session; supply both for another Machine or outside a session.',
    contextualDefaults: { machineId: 'current_session_machine', rootPath: 'current_session_root' },
    sideEffectClass: 'danger', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'workspace_files_replace', sdkMethod: 'workspace.files.replace.apply', rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: WorkspaceFilesReplaceActionInputSchema,
    outputSchema: WorkspaceFilesReplaceActionOutputSchema,
    inputHints: { fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'rootPath', title: 'Workspace root', widget: 'text' },
      { path: 'operation', title: 'Guarded replacement or restore', widget: 'json' },
    ] },
  } satisfies PreNormalizedActionSpec,
] as const);

