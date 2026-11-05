import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionListFilterFieldsV1Schema } from '../sessions/listFilter/sessionListFilterV1.js';
import { FileChangesScopeSchema } from '../scm/fileChangesScope.js';

/** Client view controls; these never change a Session's access or ownership. */
export const SCOPE_ACTION_IDS = [
  'session.list.view.get', 'session.list.view.set', 'session.list.view.reset',
  'workflow.library.view.get', 'workflow.library.view.set', 'workflow.library.view.reset',
  'shell.column.get', 'shell.column.set',
  'file.view.get', 'file.view.set',
  'file.editor.save', 'file.editor.resolve',
] as const;
export type ScopeActionId = typeof SCOPE_ACTION_IDS[number];
export const ScopeActionIdSchema = lazyZodSchema(() => z.enum(SCOPE_ACTION_IDS));

export const SessionListActionViewSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('team'), serverId: z.string().check(z.trim(), z.minLength(1)), teamId: z.string().check(z.trim(), z.minLength(1)) }),
]));
const SessionListViewTargetSchema = lazyZodSchema(() => z.strictObject({
  view: z.optional(SessionListActionViewSchema),
  storage: z.optional(z.enum(['active', 'archived'])),
}));
export const SessionListActionFiltersSchema = lazyZodSchema(() => z.extend(SessionListFilterFieldsV1Schema, { searchQuery: z.string() }));
const MutationResultSchema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));
export const WorkflowLibraryViewSchema = lazyZodSchema(() => z.enum(['all', 'triggered', 'running']));
export type WorkflowLibraryView = z.infer<typeof WorkflowLibraryViewSchema>;
export const ShellColumnSchema = lazyZodSchema(() => z.enum(['navigation', 'main', 'side']));
export type ShellColumn = z.infer<typeof ShellColumnSchema>;
export const FileViewModeSchema = lazyZodSchema(() => z.enum(['view', 'changes', 'preview', 'source', 'edit']));
export type FileViewMode = z.infer<typeof FileViewModeSchema>;

export const ScopeActionInputSchemas = {
  'session.list.view.get': SessionListViewTargetSchema,
  'session.list.view.set': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionListViewTargetSchema, {
    filters: lazyZodSchema(() => z.optional(z.partial(SessionListActionFiltersSchema))),
    includeInactive: z.optional(z.boolean()),
  }))),
  'session.list.view.reset': SessionListViewTargetSchema,
  'workflow.library.view.get': z.strictObject({}),
  'workflow.library.view.set': z.strictObject({ view: z.optional(WorkflowLibraryViewSchema), searchQuery: z.optional(z.string()) }),
  'workflow.library.view.reset': z.strictObject({}),
  'shell.column.get': z.strictObject({ column: z.optional(ShellColumnSchema) }),
  'shell.column.set': z.strictObject({ column: z.optional(ShellColumnSchema), visible: z.boolean(), tab: z.optional(z.string()) }),
  'file.view.get': z.strictObject({ tabId: z.optional(z.string().check(z.minLength(1))) }),
  'file.view.set': z.strictObject({
    tabId: z.optional(z.string().check(z.minLength(1))), mode: z.optional(FileViewModeSchema),
    changesScope: z.optional(FileChangesScopeSchema), blame: z.optional(z.boolean()),
  }),
  'file.editor.save': z.strictObject({ tabId: z.optional(z.string().check(z.minLength(1))) }),
  'file.editor.resolve': z.strictObject({
    tabId: z.optional(z.string().check(z.minLength(1))),
    resolution: z.enum(['useMine', 'useTheirs', 'discardDraft']),
  }),
} as const;

export const ScopeActionOutputSchemas = {
  'session.list.view.get': z.strictObject({
    view: SessionListActionViewSchema,
    storage: z.enum(['active', 'archived']),
    filters: SessionListActionFiltersSchema,
    includeInactive: z.boolean(),
    queryEnabled: z.boolean(),
    followingAvailable: z.boolean(),
    sourceAvailable: z.boolean(),
    homes: z.array(z.strictObject({ serverId: z.string(), label: z.string() })),
  }),
  'session.list.view.set': MutationResultSchema,
  'session.list.view.reset': MutationResultSchema,
  'workflow.library.view.get': z.strictObject({
    view: WorkflowLibraryViewSchema, searchQuery: z.string(),
    offeredViews: z.array(WorkflowLibraryViewSchema), visibleKeys: z.array(z.string()),
  }),
  'workflow.library.view.set': MutationResultSchema,
  'workflow.library.view.reset': MutationResultSchema,
  'shell.column.get': z.strictObject({ present: z.boolean(), visible: z.boolean(), available: z.boolean(),
    tabs: z.optional(z.array(z.string())), activeTab: z.optional(z.string()), label: z.optional(z.string()),
    items: z.optional(z.array(z.strictObject({ id: z.string(), label: z.string(), available: z.boolean(),
      reason: z.optional(z.string()), placement: z.enum(['pinned', 'overflow', 'hidden']), pageKind: z.string() }))) }),
  'shell.column.set': MutationResultSchema,
  'file.view.get': z.strictObject({ tabId: z.string(), mode: FileViewModeSchema,
    changesScope: z.optional(FileChangesScopeSchema), blame: z.boolean() }),
  'file.view.set': MutationResultSchema,
  'file.editor.save': z.strictObject({
    status: z.enum(['saved', 'clean', 'conflict', 'unavailable']), hash: z.optional(z.string()),
  }),
  'file.editor.resolve': z.strictObject({ status: z.enum(['resolved', 'unavailable']), hash: z.optional(z.string()) }),
} as const;

export type ScopeActionInputById = { [Id in ScopeActionId]: z.infer<typeof ScopeActionInputSchemas[Id]> };
export type ScopeActionOutputById = { [Id in ScopeActionId]: z.infer<typeof ScopeActionOutputSchemas[Id]> };
