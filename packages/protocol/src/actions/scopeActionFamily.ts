import { SCOPE_ACTION_IDS } from './scopeActionIdsV1.js';
export { SCOPE_ACTION_IDS } from './scopeActionIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionListFilterFieldsV1Schema } from '../sessions/listFilter/sessionListFilterV1.js';
import { FileChangesScopeSchema } from '../scm/fileChangesScope.js';

import { DiscussionListFilterV1Schema, DiscussionListFilterV1StoredSchema } from '../discussions/listing/discussionListFilterV1.js';
import { OpenableContentPreferenceSelectorV1Schema } from '../plugins/openableContent.js';
import { WorkspaceFileViewerIdentityV1Schema } from '../account/settings/workspaceFileViewerPreferencesV1.js';
import { StringSetSelectionV1Schema } from '../collections/filter/entityListFilterV1.js';
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

const DiscussionListViewTargetSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)), accountId: z.string().check(z.trim(), z.minLength(1)),
}));
export const SettingsColumnFilterColumnSchema = lazyZodSchema(() => z.enum(['connected-services', 'skills', 'mcp', 'agents', 'providers', 'plugins', 'store']));
export type SettingsColumnFilterColumn = z.infer<typeof SettingsColumnFilterColumnSchema>;
export const SettingsColumnFilterV1Schema = lazyZodSchema(() => z.record(z.string(), StringSetSelectionV1Schema));
export type SettingsColumnFilterV1 = z.infer<typeof SettingsColumnFilterV1Schema>;
const SettingsColumnFilterTargetSchema = lazyZodSchema(() => z.strictObject({
  column: SettingsColumnFilterColumnSchema,
  serverId: z.string().check(z.trim(), z.minLength(1)), accountId: z.string().check(z.trim(), z.minLength(1)),
}));

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
  'discussion.list.view.get': DiscussionListViewTargetSchema,
  'discussion.list.view.set': lazyZodSchema(() => z.strictObject({
    ...DiscussionListViewTargetSchema.shape,
    filters: DiscussionListFilterV1Schema, searchQuery: z.optional(z.string()),
  })),
  'discussion.list.view.reset': DiscussionListViewTargetSchema,
  'settings.column.filter.get': SettingsColumnFilterTargetSchema,
  'settings.column.filter.set': lazyZodSchema(() => z.strictObject({
    ...SettingsColumnFilterTargetSchema.shape, filters: SettingsColumnFilterV1Schema, searchQuery: z.optional(z.string()),
  })),
  'settings.column.filter.clear': SettingsColumnFilterTargetSchema,
  'shell.column.get': z.strictObject({ column: z.optional(ShellColumnSchema) }),
  'shell.column.set': z.strictObject({ column: z.optional(ShellColumnSchema), visible: z.boolean(), tab: z.optional(z.string()) }),
  'file.view.get': z.strictObject({ tabId: z.optional(z.string().check(z.minLength(1))) }),
  'file.view.set': z.strictObject({
    tabId: z.optional(z.string().check(z.minLength(1))), mode: z.optional(FileViewModeSchema),
    changesScope: z.optional(FileChangesScopeSchema), blame: z.optional(z.boolean()),
  }),
  'file.view.preference.set': lazyZodSchema(() => z.strictObject({
    mutation: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('select'), selector: OpenableContentPreferenceSelectorV1Schema,
        viewer: WorkspaceFileViewerIdentityV1Schema }),
      z.strictObject({ kind: z.literal('clear'), selector: OpenableContentPreferenceSelectorV1Schema }),
    ]),
    expectedSettingsVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
  })),
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
  'discussion.list.view.get': z.strictObject({
    serverId: z.string(), accountId: z.string(), filters: DiscussionListFilterV1StoredSchema,
    searchQuery: z.string(), selectedSpaceId: z.string(), coverage: z.enum(['complete', 'partial', 'unavailable']),
  }),
  'discussion.list.view.set': MutationResultSchema,
  'discussion.list.view.reset': MutationResultSchema,
  'settings.column.filter.get': lazyZodSchema(() => z.strictObject({
    ...SettingsColumnFilterTargetSchema.shape,
    filters: SettingsColumnFilterV1Schema,
    searchQuery: z.optional(z.string()),
    matchedCount: z.number().check(z.int(), z.nonnegative()),
    coverage: z.enum(['complete', 'partial', 'unavailable']),
  })),
  'settings.column.filter.set': MutationResultSchema,
  'settings.column.filter.clear': MutationResultSchema,
  'shell.column.get': z.strictObject({ present: z.boolean(), visible: z.boolean(), available: z.boolean(),
    tabs: z.optional(z.array(z.string())), activeTab: z.optional(z.string()), label: z.optional(z.string()),
    items: z.optional(z.array(z.strictObject({ id: z.string(), label: z.string(), available: z.boolean(),
      reason: z.optional(z.string()), placement: z.enum(['pinned', 'overflow', 'hidden']), pageKind: z.string() }))) }),
  'shell.column.set': MutationResultSchema,
  'file.view.get': z.strictObject({ tabId: z.string(), mode: FileViewModeSchema,
    changesScope: z.optional(FileChangesScopeSchema), blame: z.boolean() }),
  'file.view.set': MutationResultSchema,
  'file.view.preference.set': z.strictObject({ status: z.literal('applied'), settingsVersion: z.number().check(z.int(), z.nonnegative()) }),
  'file.editor.save': z.strictObject({
    status: z.enum(['saved', 'clean', 'conflict', 'unavailable']), hash: z.optional(z.string()),
  }),
  'file.editor.resolve': z.strictObject({ status: z.enum(['resolved', 'unavailable']), hash: z.optional(z.string()) }),
} as const;

export type ScopeActionInputById = { [Id in ScopeActionId]: z.infer<typeof ScopeActionInputSchemas[Id]> };
export type ScopeActionOutputById = { [Id in ScopeActionId]: z.infer<typeof ScopeActionOutputSchemas[Id]> };
