import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { SessionDraftAddressV1Schema } from '../drafts/sessionDrafts.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { ComposerRefV1Schema } from '../plugins/ui/composerRef.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';

export const APP_SHELL_ACTION_IDS = ['session.work.get', 'inbox.get', 'inbox.mark_all_read', 'session.draft.delete', 'session.draft.directory.set', 'session.draft.append'] as const;
export type AppShellActionId = typeof APP_SHELL_ACTION_IDS[number];
export function isAppShellActionId(value: string): value is AppShellActionId {
  return (APP_SHELL_ACTION_IDS as readonly string[]).includes(value);
}

const InboxTargetSchema = lazyZodSchema(() => z.object({ serverId: z.string().min(1), sessionId: z.string().min(1) }).strict());
const WorkReadItemSchema = z.object({
  key: z.string(), kind: z.enum(['session', 'workflow_run', 'background_run', 'agent', 'project_command']),
  title: z.string(), agentId: z.string().nullable(), facts: z.array(z.string()), parentKey: z.string().nullable(), level: z.number(),
  status: z.object({ bucket: z.enum(['needs_you', 'working', 'finished', 'idle', 'offline']),
    tone: z.enum(['neutral', 'attention', 'danger']), word: z.string() }).strict(),
  progress: z.object({ completed: z.number(), total: z.number() }).strict().nullable(),
  open: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session'), sessionId: z.string() }).strict(),
    z.object({ kind: z.literal('workflow_run'), runId: z.string() }).strict(),
    z.object({ kind: z.literal('action_operation'), serverId: z.string(), operationId: z.string() }).strict(),
    z.object({ kind: z.literal('agent_activity'), entryId: z.string(), subagentId: z.string().nullable(), runId: z.string().nullable() }).strict(),
  ]),
}).strict();
const ReadUnavailableSchema = z.object({ status: z.literal('unavailable') }).strict();
const ReadLoadingSchema = z.object({ status: z.literal('loading') }).strict();
const InboxReadItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), key: z.string(), serverId: z.string(), sessionId: z.string(), title: z.string(),
    attentionState: z.string(), pendingPermissionCount: z.number(), pendingQuestionCount: z.number(), foldedUnderRunId: z.string().nullable() }).strict(),
  z.object({ kind: z.literal('workflow_run'), key: z.string(), runId: z.string() }).strict(),
  z.object({ kind: z.literal('stalled'), key: z.string(), serverId: z.string(), sessionId: z.string() }).strict(),
  z.object({ kind: z.literal('landing'), key: z.string(), serverId: z.string(), sessionId: z.string(), pullRequestNumber: z.number() }).strict(),
  z.object({ kind: z.literal('snoozed'), key: z.string(), serverId: z.string(), sessionId: z.string(), remindAt: z.number() }).strict(),
]);
const InboxReadGroupSchema = z.object({ key: z.string(), root: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lead'), sessionId: z.string() }).strict(),
  z.object({ kind: z.literal('run'), runId: z.string() }).strict(),
  z.object({ kind: z.literal('other') }).strict(),
]), items: z.array(InboxReadItemSchema) }).strict();
export const AppShellActionInputSchemas = {
  'session.work.get': z.object({ sessionId: z.string().min(1) }).strict(),
  'inbox.get': z.object({}).strict(),
  'inbox.mark_all_read': z.object({ targets: z.array(InboxTargetSchema) }).strict(),
  'session.draft.delete': z.object({ draftId: SessionDraftAddressV1Schema.options[0].shape.draftId }).strict(),
  'session.draft.directory.set': z.object({ ref: asProtocolZod(ComposerRefV1Schema).refine(ref => ref.kind === 'newSession'),
    directory: SessionDirectoryIntentV1Schema }).strict(),
  'session.draft.append': z.object({ sessionId: z.string().trim().min(1),
    text: z.string().refine(text => text.trim().length > 0), sourceSessionId: z.string().trim().min(1).optional() }).strict(),
} as const;
export const AppShellActionOutputSchemas = {
  'session.work.get': z.discriminatedUnion('status', [ReadUnavailableSchema, ReadLoadingSchema, z.object({
    status: z.literal('ready'), sessionId: z.string(),
    summary: z.object({ outstanding: z.number(), needsYou: z.number(), stalled: z.number(), sessions: z.number(), runs: z.number() }).strict(),
    items: z.array(WorkReadItemSchema),
    managedRuns: z.object({ phase: z.enum(['idle', 'loading', 'loaded', 'failed']), refreshFailed: z.boolean() }).strict(),
  }).strict()]),
  'inbox.get': z.discriminatedUnion('status', [ReadUnavailableSchema, ReadLoadingSchema, z.object({
    status: z.literal('ready'), groups: z.array(InboxReadGroupSchema),
    approvalIds: z.array(z.string()), usageNoticeIds: z.array(z.string()), friendRequestIds: z.array(z.string()),
    automationRunIds: z.array(z.string()),
    readySessions: z.array(InboxTargetSchema),
    actionOperations: z.array(z.object({ serverId: z.string(), operationId: z.string(), reason: z.string() }).strict()),
    isLoading: z.boolean(), refreshFailed: z.boolean(),
  }).strict()]),
  'inbox.mark_all_read': z.object({ results: z.array(InboxTargetSchema.extend({
    status: z.enum(['succeeded', 'failed', 'skipped', 'cancelled']),
  })) }).strict(),
  'session.draft.delete': z.object({ status: z.enum(['deleted', 'missing', 'launch_custody', 'unavailable']) }).strict(),
  'session.draft.directory.set': z.object({ status: z.enum(['applied', 'unavailable']) }).strict(),
  'session.draft.append': z.discriminatedUnion('status', [ReadUnavailableSchema, z.object({
    status: z.literal('appended'), sessionId: z.string().min(1), createdAtMs: z.number().int().nonnegative(),
  }).strict()]),
} as const;

export const APP_SHELL_ACTION_SPECS = [
  {
    id: 'session.draft.append', title: 'Append to a Session draft',
    description: 'Persist an append handoff for the exact Session composer on the invoking Home. Preserves existing draft text and never submits a message.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_append' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.append'], outputSchema: AppShellActionOutputSchemas['session.draft.append'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Destination Session', widget: 'text', required: true },
      { path: 'text', title: 'Draft text', widget: 'text', required: true },
      { path: 'sourceSessionId', title: 'Source Session', widget: 'text' }] },
  },
  {
    id: 'session.work.get', title: 'Read Session Work',
    description: 'Read the answering client’s mounted canonical Work projection for one exact Session. Unavailable without its mounted owner; never loads a second projection.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_work_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.work.get'], outputSchema: AppShellActionOutputSchemas['session.work.get'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }] },
  },
  {
    id: 'inbox.get', title: 'Read Inbox',
    description: 'Read the answering client’s open canonical Inbox for the exact invoking Home and Account. Unavailable without its mounted owner; never opens or loads Inbox.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'inbox_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['inbox.get'], outputSchema: AppShellActionOutputSchemas['inbox.get'],
    inputHints: { fields: [] },
  },
  {
    id: 'inbox.mark_all_read', title: 'Mark Inbox as read',
    description: 'Mark an exact Home-scoped Inbox snapshot read. Does not resolve approvals, mentions or human attention.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'inbox_mark_all_read' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['inbox.mark_all_read'], outputSchema: AppShellActionOutputSchemas['inbox.mark_all_read'],
    inputHints: { fields: [{ path: 'targets', title: 'Inbox snapshot', widget: 'json', required: true }] },
  },
  {
    id: 'session.draft.delete', title: 'Delete a New Session draft',
    description: 'Delete an exact New Session draft on the answering client through draft tombstone and attachment cleanup. Refuses launches already in custody.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_delete' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.delete'], outputSchema: AppShellActionOutputSchemas['session.draft.delete'],
    inputHints: { fields: [{ path: 'draftId', title: 'Draft id', widget: 'text', required: true }] },
  },
  {
    id: 'session.draft.directory.set', title: 'Set New Session draft directory',
    description: 'Set folder or no-folder intent on one exact mounted editable New Session composer. Does not launch a Session or create a directory.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_directory_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.directory.set'], outputSchema: AppShellActionOutputSchemas['session.draft.directory.set'],
    inputHints: { fields: [{ path: 'ref', title: 'Exact New Session composer', widget: 'json', required: true },
      { path: 'directory', title: 'Directory intent', widget: 'json', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
