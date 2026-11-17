import { lazyActionSpecArray, lazyActionSpecRecord } from './lazyActionSpecValue.js';
import { APP_SHELL_ACTION_IDS } from './appShellActionIdsV1.js';
export { APP_SHELL_ACTION_IDS } from './appShellActionIdsV1.js';
import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { SessionDraftAddressV1Schema } from '../drafts/sessionDrafts.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { ComposerRefV1Schema } from '../plugins/ui/composerRef.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { ProviderBoundModelRefSchema } from '../providers/selection/v1.js';
import { SessionModelSelectionSchema } from '../providers/selection/v2.js';
import { PersistedBackendTargetRefV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../teams/credentials/providerModelCatalogV1.js';
import { DiscussionMessageRefV1Schema } from '../discussions/references.js';
import { DiscussionSelectionSourceV1Schema } from '../discussions/content.js';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from '../discussions/replyTargets.js';
import { DocEditProposalDispositionV1Schema } from '../discussions/docEditProposalDispositionV1.js';
import { SessionQuestionContextV1Schema } from '../sessions/permissions/questionV1.js';
import type { ActionExecutorContext } from './executor/types.js';
import { AccountNoticeDismissInputV1Schema, AccountNoticeDismissResultV1Schema } from '../activity/accountNoticeRecoveryV1.js';
export { dismissAccountNoticeArtifactV1 } from '../activity/accountNoticeDismissalV1.js';

/** One host-enforced Account admission for private notices and headless Inbox reads. */
export function readNoticeInboxAccountIdV1(context: ActionExecutorContext, intent: 'acknowledge' | 'read' = 'acknowledge'): string | null {
  const accountId = context.expectedAccountId ?? context.runtimeAccountId;
  if (!accountId || context.externalActionCredential || context.rpcSessionAuthorization
    || context.runtimeAccountId && context.runtimeAccountId !== accountId) return null;
  const binding = context.externalActionExecutionAuthorization?.binding;
  // The receiving host has already verified this proof. An own-Account signed
  // CLI root is not an API credential or authority over a foreign custodian.
  if (binding && (!('authentication' in binding) || binding.accountId !== accountId
    || binding.custodianAccountId !== accountId)) return null;
  // Trusted plugins may read exact private evidence in their host-admitted
  // Account. This does not grant Inbox acknowledgement or producer writes.
  if (intent === 'read' && context.surface === 'plugin' && context.authority === 'account_automation'
    && context.actionCaller?.kind === 'plugin') return accountId;
  const host = context.actionCaller === undefined || context.actionCaller.kind === 'host';
  if (host && (context.surface === 'ui' && context.authority === 'present_user'
    || context.surface === 'voice' && (context.authority === 'account_automation'
      || context.authority === 'present_user'))) return accountId;
  return (context.surface === 'cli' || context.surface === 'agent' || context.surface === 'mcp')
    && (context.authority === 'account_automation' || context.authority === 'present_user')
    && context.runtimeAccountId === accountId && (host || context.actionCaller?.kind === 'session') ? accountId : null;
}
export type AppShellActionId = typeof APP_SHELL_ACTION_IDS[number];
export function isAppShellActionId(value: string): value is AppShellActionId {
  return (APP_SHELL_ACTION_IDS as readonly string[]).includes(value);
}

const InboxTargetSchema = lazyZodSchema(() => z.strictObject({ serverId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)) }));
const WorkReadItemSchema = z.strictObject({
  key: z.string(), kind: z.enum(['session', 'workflow_run', 'background_run', 'agent', 'project_command']),
  title: z.string(), agentId: z.nullable(z.string()), facts: z.array(z.string()), parentKey: z.nullable(z.string()), level: z.number(),
  status: z.strictObject({ bucket: z.enum(['needs_you', 'working', 'finished', 'idle', 'offline']),
    tone: z.enum(['neutral', 'attention', 'danger']), word: z.string() }),
  progress: z.nullable(z.strictObject({ completed: z.number(), total: z.number() })),
  open: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('session'), sessionId: z.string() }),
    z.strictObject({ kind: z.literal('workflow_run'), runId: z.string() }),
    z.strictObject({ kind: z.literal('action_operation'), serverId: z.string(), operationId: z.string() }),
    z.strictObject({ kind: z.literal('agent_activity'), entryId: z.string(), subagentId: z.nullable(z.string()), runId: z.nullable(z.string()) }),
  ]),
});
const ReadUnavailableSchema = z.strictObject({ status: z.literal('unavailable') });
const ReadLoadingSchema = z.strictObject({ status: z.literal('loading') });
const InboxReadItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), key: z.string(), serverId: z.string(), sessionId: z.string(), title: z.string(),
    attentionState: z.string(), pendingPermissionCount: z.number(), pendingQuestionCount: z.number(), foldedUnderRunId: z.nullable(z.string()) }),
  z.strictObject({ kind: z.literal('workflow_run'), key: z.string(), runId: z.string() }),
  z.strictObject({ kind: z.literal('automation_run'), key: z.string(), runId: z.string() }),
  z.strictObject({ kind: z.literal('approval'), key: z.string(), artifactId: z.string() }),
  z.strictObject({ kind: z.literal('stalled'), key: z.string(), serverId: z.string(), sessionId: z.string() }),
  z.strictObject({ kind: z.literal('landing'), key: z.string(), serverId: z.string(), sessionId: z.string(), pullRequestNumber: z.number(), pullRequestUrl: z.string().check(z.url()),
    pullRequestState: z.optional(z.enum(['open', 'merged', 'closed', 'unknown'])), pullRequestObservedAt: z.optional(z.number().check(z.int(), z.nonnegative())) }),
  z.strictObject({ kind: z.literal('snoozed'), key: z.string(), serverId: z.string(), sessionId: z.string(), remindAt: z.number() }),
]);
const InboxReadGroupSchema = z.strictObject({ key: z.string(), root: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('lead'), serverId: z.string().check(z.minLength(1)), sessionId: z.string() }),
  z.strictObject({ kind: z.literal('run'), runId: z.string() }),
  z.strictObject({ kind: z.literal('automation'), automationId: z.string(), serverId: z.string(), runId: z.string() }),
  z.strictObject({ kind: z.literal('other') }),
]), items: z.array(InboxReadItemSchema) });
// The mounted Inbox owns classification and navigation. This closed read projection
// carries its admitted rows without copying source content or becoming another builder.
export const InboxExpectedHealthOperationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['stop', 'restart', 'deploy', 'reboot', 'backup']),
  operation: z.strictObject({ serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
    operationId: z.string().check(z.minLength(1)) }),
}));
export type InboxExpectedHealthOperationV1 = z.infer<typeof InboxExpectedHealthOperationV1Schema>;
const InboxCanonicalItemSchema = lazyZodSchema(() => z.strictObject({
  key: z.string(), producer: z.enum(['live', 'notice']),
  type: z.enum(['decision', 'approval', 'blocked', 'update', 'mention']),
  view: z.enum(['needs_you', 'updates', 'mentions']),
  title: z.string(), context: z.nullable(z.string()), createdAt: z.number(), read: z.boolean(), pageRoute: z.string(),
  expectedDuring: z.optional(InboxExpectedHealthOperationV1Schema),
  source: z.strictObject({ kind: z.string(), id: z.string(), serverId: z.string(), displayName: z.optional(z.nullable(z.string())) }),
  focus: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('session'), serverId: z.string(), id: z.string(), jumpSeq: z.optional(z.number()) }),
    z.strictObject({ kind: z.literal('approval'), serverId: z.string(), id: z.string() }),
    z.strictObject({ kind: z.literal('notice'), serverId: z.string(), id: z.string() }),
    z.strictObject({ kind: z.literal('managed_machine'), serverId: z.string(), id: z.string() }),
    z.strictObject({ kind: z.literal('workflow_run'), serverId: z.string(), id: z.string(), invocationId: z.optional(z.string()) }),
    z.strictObject({ kind: z.literal('execution_run'), serverId: z.string(), id: z.string(),
      sessionId: z.optional(z.string()), machineId: z.optional(z.string()) })
      .check(z.refine(value => (value.sessionId !== undefined) !== (value.machineId !== undefined))),
    z.strictObject({ kind: z.literal('automation_run'), serverId: z.string(), id: z.string(), automationId: z.string() }),
    z.strictObject({ kind: z.literal('discussion'), serverId: z.string(), id: z.string(), messageId: z.string() }),
  ]),
  question: z.optional(z.safeExtend(SessionQuestionContextV1Schema, { requestId: z.string(),
    currentHandler: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('person') }),
      z.strictObject({ kind: z.literal('session'), address: InboxTargetSchema })]) })),
  discussion: z.optional(z.strictObject({ accountId: z.string(), messageRef: DiscussionMessageRefV1Schema,
    seq: z.number().check(z.int(), z.nonnegative()), anchor: z.nullable(DiscussionAnchorV1Schema),
    replyTarget: z.optional(DiscussionReplyTargetV1Schema), proposalDisposition: z.optional(DocEditProposalDispositionV1Schema) })),
}));

/** Both mounted and headless readers serialize the same admitted transient items. */
export function projectInboxReadItemV1(item: z.infer<typeof InboxCanonicalItemSchema>): z.infer<typeof InboxCanonicalItemSchema> {
  return InboxCanonicalItemSchema.parse({ key: item.key, producer: item.producer, type: item.type, view: item.view,
    title: item.title, context: item.context, createdAt: item.createdAt, read: item.read, focus: item.focus,
    pageRoute: item.pageRoute,
    ...(item.expectedDuring ? { expectedDuring: item.expectedDuring } : {}),
    source: { kind: item.source.kind, id: item.source.id, serverId: item.source.serverId,
      ...(item.source.displayName === undefined ? {} : { displayName: item.source.displayName }) },
    ...(item.question ? { question: item.question } : {}), ...(item.discussion ? { discussion: item.discussion } : {}),
  });
}
export const NewSessionDraftModelIntentSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mode'), modelId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('selection'), ref: z.nullable(ProviderBoundModelRefSchema) }),
  z.strictObject({ kind: z.literal('team'), selection: z.nullable(TeamCredentialProviderModelSelectionV1Schema) }),
]));
export type NewSessionDraftModelIntent = z.infer<typeof NewSessionDraftModelIntentSchema>;
export const SessionAgentPickerSelectionSchema = lazyZodSchema(() => z.strictObject({
    modelId: z.string().check(z.minLength(1)),
    modelSelection: z.optional(z.nullable(SessionModelSelectionSchema)),
    modelLabel: z.optional(z.nullable(z.string())),
    sessionModeId: z.nullable(z.string()),
    configOverrides: z.record(z.string(), z.string()),
}));
export const NewSessionDraftAgentIntentSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('target'), backendTarget: PersistedBackendTargetRefV2Schema }),
  z.strictObject({ kind: z.literal('picker'), backendTarget: PersistedBackendTargetRefV2Schema,
    selection: SessionAgentPickerSelectionSchema }),
  z.strictObject({ kind: z.literal('mode'), sessionModeId: z.nullable(z.string()) }),
  z.strictObject({ kind: z.literal('config'), configId: z.string().check(z.trim(), z.minLength(1)), value: z.string() }),
]));
export type NewSessionDraftAgentIntent = z.infer<typeof NewSessionDraftAgentIntentSchema>;

export const AppShellActionInputSchemas = lazyActionSpecRecord(() => {
  'session.work.get': z.strictObject({ sessionId: z.string().check(z.minLength(1)) }),
  'inbox.get': z.strictObject({}),
  'inbox.mark_all_read': z.strictObject({ targets: z.array(InboxTargetSchema) }),
  'inbox.notice.dismiss': AccountNoticeDismissInputV1Schema,
  'session.draft.open': z.strictObject({ draftId: SessionDraftAddressV1Schema._zod.def.options[0].shape.draftId }),
  'session.draft.delete': z.strictObject({ draftId: SessionDraftAddressV1Schema._zod.def.options[0].shape.draftId }),
  'session.draft.directory.set': z.strictObject({ ref: asProtocolZod(ComposerRefV1Schema).check(zMini.refine(ref => ref.kind === 'newSession')),
    directory: SessionDirectoryIntentV1Schema }),
  'session.draft.model.set': z.strictObject({ ref: asProtocolZod(ComposerRefV1Schema).check(zMini.refine(ref => ref.kind === 'newSession' || ref.kind === 'session')),
    model: NewSessionDraftModelIntentSchema }),
  'session.draft.agent.set': z.strictObject({ ref: asProtocolZod(ComposerRefV1Schema).check(zMini.refine(ref => ref.kind === 'newSession' || ref.kind === 'session')),
    agent: NewSessionDraftAgentIntentSchema }),
  'session.draft.append': z.strictObject({ sessionId: z.string().check(z.trim(), z.minLength(1)),
    text: z.string().check(z.refine(text => text.trim().length > 0)), sourceSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    discussionSource: z.optional(z.omit(DiscussionSelectionSourceV1Schema, { draftCorrelationId: true })) }),
} as const);
export const AppShellActionOutputSchemas = lazyActionSpecRecord(() => {
  'session.work.get': z.discriminatedUnion('status', [ReadUnavailableSchema, ReadLoadingSchema, z.strictObject({
    status: z.literal('ready'), sessionId: z.string(),
    summary: z.strictObject({ outstanding: z.number(), needsYou: z.number(), stalled: z.number(), sessions: z.number(), runs: z.number() }),
    items: z.array(WorkReadItemSchema),
    managedRuns: z.strictObject({ phase: z.enum(['idle', 'loading', 'loaded', 'failed']), refreshFailed: z.boolean() }),
  })]),
  'inbox.get': z.discriminatedUnion('status', [ReadUnavailableSchema, ReadLoadingSchema, z.strictObject({
    status: z.enum(['ready', 'partial']), groups: z.array(InboxReadGroupSchema),
    items: z.array(InboxCanonicalItemSchema),
    coverage: z.strictObject({ discussions: z.enum(['complete', 'partial', 'unavailable']),
      sources: z.optional(z.array(z.strictObject({ source: z.enum(['notices', 'live_items', 'action_operations', 'friend_requests']),
        status: z.enum(['complete', 'partial', 'unavailable']), reason: z.optional(z.enum(['requires_app_projection', 'device_local', 'content_unavailable'])) }))) }),
    approvalIds: z.array(z.string()), usageNoticeIds: z.array(z.string()), accountNoticeIds: z.optional(z.array(z.string())), friendRequestIds: z.array(z.string()),
    automationRunIds: z.array(z.string()),
    readySessions: z.array(InboxTargetSchema),
    actionOperations: z.array(z.strictObject({ serverId: z.string(), operationId: z.string(), reason: z.string() })),
    isLoading: z.boolean(), refreshFailed: z.boolean(),
  })]),
  'inbox.mark_all_read': z.strictObject({ results: z.array(lazyZodSchema(() => z.extend(InboxTargetSchema, {
    status: z.enum(['succeeded', 'failed', 'skipped', 'cancelled']),
  }))) }),
  'session.draft.delete': z.strictObject({ status: z.enum(['deleted', 'missing', 'launch_custody', 'unavailable']) }),
  'inbox.notice.dismiss': AccountNoticeDismissResultV1Schema,
  'session.draft.open': z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('opened'), draftId: SessionDraftAddressV1Schema._zod.def.options[0].shape.draftId }),
    z.strictObject({ status: z.enum(['missing', 'unavailable']) }),
  ]),
  'session.draft.directory.set': z.strictObject({ status: z.enum(['applied', 'unavailable']) }),
  'session.draft.model.set': z.strictObject({ status: z.enum(['applied', 'unavailable']) }),
  'session.draft.agent.set': z.strictObject({ status: z.enum(['applied', 'unavailable']) }),
  'session.draft.append': z.discriminatedUnion('status', [ReadUnavailableSchema, z.strictObject({
    status: z.literal('appended'), sessionId: z.string().check(z.minLength(1)), createdAtMs: z.number().check(z.int(), z.nonnegative()),
  })]),
} as const);

function createAppShellActionSpecs() {
  return [
  {
    id: 'inbox.notice.dismiss', approval: { result: 'required' }, title: 'Dismiss an Inbox notice',
    description: 'Dismiss one current private notice on the invoking Home and own Account. Keeps its evidence and never recovers a deployment.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account',
    placements: [], bindings: { mcpToolName: 'inbox_notice_dismiss' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['inbox', 'notice', 'dismiss'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['inbox.notice.dismiss'], outputSchema: AppShellActionOutputSchemas['inbox.notice.dismiss'],
    inputHints: { fields: [{ path: 'artifactId', title: 'Notice id', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Displayed notice revision', widget: 'json' }] },
  },
  {
    id: 'session.draft.open', approval: {result: 'required'}, title: 'Open a saved New Session draft',
    description: 'Open the exact saved New Session draft on its captured Home and Account. Preserves its content and never starts a Session.',
    safety: 'safe', sideEffectClass: 'external', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_open' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'draft', 'open'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.open'], outputSchema: AppShellActionOutputSchemas['session.draft.open'],
    inputHints: { fields: [{ path: 'draftId', title: 'Draft id', widget: 'text', required: true }] },
  },
  {
    id: 'session.draft.append', approval: {result: 'required'}, title: 'Append to a Session draft',
    clientPresenter: 'session',
    description: 'Append to the exact Session repository draft on the invoking Home. Preserves existing draft text and never submits a message.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_append' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'draft', 'append'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.append'], outputSchema: AppShellActionOutputSchemas['session.draft.append'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Destination Session', widget: 'text', required: true },
      { path: 'text', title: 'Draft text', widget: 'text', required: true },
      { path: 'sourceSessionId', title: 'Source Session', widget: 'text' }] },
  },
  {
    id: 'session.work.get', approval: {result: 'required'}, title: 'Read Session Work',
    clientPresenter: 'session',
    description: 'Read the answering client’s mounted canonical Work projection for one exact Session. Unavailable without its mounted owner; never loads a second projection.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_work_get', voiceClientToolName: 'session_work_get' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'work', 'get'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.work.get'], outputSchema: AppShellActionOutputSchemas['session.work.get'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }] },
  },
  {
    id: 'inbox.get', approval: {result: 'required'}, title: 'Read Inbox',
    description: 'Read the canonical Inbox for the invoking Home and own Account. Without a mounted app, reads owned notices and reports unavailable source projections as partial; never opens Inbox.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'inbox_get', voiceClientToolName: 'inbox_get' },
    prompting: { voiceHotPath: true },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['inbox', 'get'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['inbox.get'], outputSchema: AppShellActionOutputSchemas['inbox.get'],
    inputHints: { fields: [] },
  },
  {
    id: 'inbox.mark_all_read', approval: {result: 'required'}, title: 'Mark Inbox as read',
    description: 'Mark an exact Home-scoped Inbox snapshot read. Does not resolve approvals, mentions or human attention.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'inbox_mark_all_read', voiceClientToolName: 'inbox_mark_all_read' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['inbox', 'mark-all-read'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['inbox.mark_all_read'], outputSchema: AppShellActionOutputSchemas['inbox.mark_all_read'],
    inputHints: { fields: [{ path: 'targets', title: 'Inbox snapshot', widget: 'json', required: true }] },
  },
  {
    id: 'session.draft.delete', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'policy' }, title: 'Delete a New Session draft',
    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    description: 'Delete an exact New Session draft on the answering client through draft tombstone and attachment cleanup. Refuses launches already in custody.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_delete' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'draft', 'delete'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.delete'], outputSchema: AppShellActionOutputSchemas['session.draft.delete'],
    inputHints: { fields: [{ path: 'draftId', title: 'Draft id', widget: 'text', required: true }] },
  },
  {
    id: 'session.draft.model.set', approval: {result: 'required'}, title: 'Set draft model',
    description: 'Select a model on one exact mounted editable New Session draft or armed Session continuation through its existing picker owner. Does not send input or change the running Agent.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_model_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'draft', 'model', 'set'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.model.set'], outputSchema: AppShellActionOutputSchemas['session.draft.model.set'],
    inputHints: { fields: [{ path: 'ref', title: 'Exact mounted composer', widget: 'json', required: true },
      { path: 'model', title: 'Model selection', widget: 'json', required: true }] },
  },
  {
    id: 'session.draft.agent.set', approval: {result: 'required'}, title: 'Set draft Agent',
    description: 'Select an Agent, model, mode and config on one exact mounted editable New Session draft or arm a Session continuation through its existing Agent picker owner. Does not send input or change the running Agent.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_agent_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'draft', 'agent', 'set'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.agent.set'], outputSchema: AppShellActionOutputSchemas['session.draft.agent.set'],
    inputHints: { fields: [{ path: 'ref', title: 'Exact mounted composer', widget: 'json', required: true },
      { path: 'agent', title: 'Agent selection', widget: 'json', required: true }] },
  },
  {
    id: 'session.draft.directory.set', approval: {result: 'required'}, title: 'Set New Session draft directory',
    description: 'Set folder or no-folder intent on one exact mounted editable New Session composer. Does not launch a Session or create a directory.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], bindings: { mcpToolName: 'session_draft_directory_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'draft', 'directory', 'set'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: AppShellActionInputSchemas['session.draft.directory.set'], outputSchema: AppShellActionOutputSchemas['session.draft.directory.set'],
    inputHints: { fields: [{ path: 'ref', title: 'Exact New Session composer', widget: 'json', required: true },
      { path: 'directory', title: 'Directory intent', widget: 'json', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const APP_SHELL_ACTION_SPECS: ReturnType<typeof createAppShellActionSpecs> = lazyActionSpecArray(createAppShellActionSpecs);
