import { SessionModelTransitionResultV1Schema } from '../../../sessions/control/modelTransitionV1.js';
import { SessionIdRequiredInputSchema, SessionTargetRequiredInputSchema } from '../common.js';
import type { PreNormalizedActionSpec } from '../definition.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { parseQualifiedPluginActionId } from '../../../plugins/actions/qualifiedActionId.js';
import { SessionTargetV1Schema, SessionTargetPreviewV1Schema, withSessionTargetFanoutResultV1, type SessionTargetV1 } from '../../sessionTargetV1.js';
import { SessionCoordinatorEnableInputV1Schema, SessionCoordinatorEnableResultV1Schema } from '../../../sessions/follow/sessionCoordinatorActionsV1.js';
import { SessionStatusActionResultV1Schema, SessionArchiveActionInputV1Schema, SessionArchiveActionResultV1Schema } from '../../../sessions/control/contract.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../../../connect/connectedAccountPurposeBindings.js';
import { SessionModelMutationExpectedV1Schema, SessionModelSetResultV1Schema } from '../../../sessions/control/modelTransitionV1.js';
import { BotSetInputSchema } from '../../../sessions/identity/sessionBotV1.js';
import { SessionTitleSetInputSchema, SessionStatusReasonSetInputSchema, SessionStatusReasonSetResultSchema, SessionToolCallsSetInputSchema, SessionMemorySetInputV1Schema, SessionVoicePreferenceSetInputV1Schema, SessionContextUpdateInputV1Schema, SessionInstructionsSetInputV1Schema } from '../../sessionStateFieldActions.js';
import { z } from 'zod/mini';
import { SetSessionTagAssignmentsRequestSchema, SetSessionTagAssignmentsResponseSchema } from '../../../sessions/organization/mutations.js';
import { SessionSpaceMembershipSetInputV1Schema, SessionSpaceMembershipSetResultV1Schema } from '../../sessionSpaceMembership.js';
import { SESSION_LIST_AWARENESS_VIEW_V1, SESSION_LIST_SUMMARY_VIEW_V1, SessionListViewV1Schema, type SessionListViewV1 } from '../../../sessions/awareness/action.js';
import { ActionIdSchema } from '../../actionIds.js';
import { type ActionInputOption } from '../../actionInputHints.js';
import { ProviderConnectionIdSchema } from '../../../providers/ids.js';
import { SESSION_PERMISSION_INTENT_INPUTS, SessionPermissionModeInputSchema } from '../../../sessions/metadata/sessionPermissionModes.js';
import { SessionWorkStateStatusV1Schema } from '../../../sessions/work/state/sessionWorkStateV1.js';
import { SESSION_RPC_METHODS } from '../../../rpc/methods.js';
import { SessionSectionSetInputV1Schema, SessionSectionSetResultV1Schema } from '../../sessionSections.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../../../teams/credentials/resourceV1.js';
import { SESSION_ARCHIVE_CLI_PROJECTION, SESSION_MODEL_SET_CLI_PROJECTION, SESSION_PERMISSION_MODE_SET_CLI_PROJECTION, SessionPermissionModeSetApplyTimingSchema, SESSION_STATUS_GET_CLI_PROJECTION, SESSION_TITLE_SET_CLI_PROJECTION, SESSION_UNARCHIVE_CLI_PROJECTION } from '../sessionCommandCli.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { NonBlankOpaqueIdentifierSchema } from '../../../strings/opaqueIdentifier.js';

export const SessionTargetsResolveInputV1Schema: z.ZodMiniType<
  { target: SessionTargetV1; actionId: string },
  { target: SessionTargetV1; actionId: string }
> = lazyZodSchema(() => z.strictObject({
  target: SessionTargetV1Schema,
  actionId: z.string().check(z.refine(id => ActionIdSchema.safeParse(id).success || parseQualifiedPluginActionId(id) !== null)),
}));

const SessionDeleteInputSchema = lazyZodSchema(() => z.strictObject({ sessionId: z.string().check(z.trim(), z.minLength(1)) }));

export const SessionPermissionModeSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
  permissionMode: SessionPermissionModeInputSchema,
  applyTiming: z.optional(SessionPermissionModeSetApplyTimingSchema),
}));

export const SessionModelSetInputSchema = lazyZodSchema(() => z.looseObject({
  applyTiming: z.optional(z.enum(['immediate', 'next_prompt'])),
  sessionId: z.string().check(z.minLength(1)),
  modelId: z.optional(NonBlankOpaqueIdentifierSchema),
  providerConnectionId: z.optional(z.nullable(ProviderConnectionIdSchema)),
  teamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
  teamVisibilityGrantConsent: z.optional(z.strictObject({ teamId: z.string().check(z.minLength(1)) })),
  captureBefore: z.optional(z.boolean()),
  expected: z.optional(SessionModelMutationExpectedV1Schema),
}).check(z.superRefine((value, context) => {
  const hasTeamSelection = value.teamCredentialModel !== undefined;
  const hasLegacySelection = value.modelId !== undefined || value.providerConnectionId !== undefined;
  if (hasTeamSelection === hasLegacySelection) {
    context.addIssue({
      code: "custom",
      path: ['teamCredentialModel'],
      message: 'Select exactly one model source',
    });
  }
  if (!hasTeamSelection && value.modelId === undefined) {
    context.addIssue({ code: "custom", path: ['modelId'], message: 'modelId is required' });
  }
  if (value.teamVisibilityGrantConsent && value.teamVisibilityGrantConsent.teamId !== value.teamCredentialModel?.teamId) {
    context.addIssue({ code: "custom", path: ['teamVisibilityGrantConsent'], message: 'Consent must match the selected Team' });
  }
})));

export const SessionStatusGetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
  includeAcceptedWorkspace: z.optional(z.boolean()),
  live: z.optional(z.boolean()),
  readiness: z.optional(z.boolean()),
  operation: z.optional(z.enum(['conversation', 'credential'])),
  credentialPurpose: z.optional(QualifiedConnectedAccountPurposeV1Schema),
  credentialTeamSelection: z.optional(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema),
}));

export const SessionGoalSetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
  objective: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4000))),
  status: z.optional(SessionWorkStateStatusV1Schema),
  tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
  resumeInactiveWithInitialGoal: z.optional(z.boolean()),
}).check(z.refine((value) => (
  typeof value.objective === 'string'
  || typeof value.status === 'string'
  || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
), { message: 'At least one goal mutation field is required' })));

export const SESSION_VIEW_INPUT_OPTION_LABELS: Readonly<Record<SessionListViewV1, string>> = {
  [SESSION_LIST_SUMMARY_VIEW_V1]: 'Summary',
  [SESSION_LIST_AWARENESS_VIEW_V1]: 'Awareness',
};

/**
 * Every Session read that offers the representation selector offers the same values, derived from
 * the awareness contract that owns them. A spec listing its own literals would drift the moment
 * that enum changes.
 */
export const SESSION_VIEW_INPUT_OPTIONS: ActionInputOption[] = SessionListViewV1Schema.options.map((view) => ({
  value: view,
  label: SESSION_VIEW_INPUT_OPTION_LABELS[view],
}));

export const SESSION_STATE_ACTION_SPECS = Object.freeze([
  {
    id: 'session.coordinator.enable', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    title: 'Make coordinator',
    description: 'Configure this session through existing role, Bot, pin, manager and Important Follow rule Actions; returns each effect separately.',
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_coordinator_enable', voiceClientToolName: 'makeSessionCoordinator' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    examples: { voice: { argsExample: '{"sessionId":"session_123","roleId":"orchestrator","keep":"none","ruleSuggestions":[]}' } },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session', widget: 'text', required: true },
      { path: 'roleId', title: 'Role', widget: 'text', required: true },
      { path: 'keep', title: 'Where to keep it', widget: 'select', required: true, options: [
        { value: 'rail_bot', label: 'Left rail, as a Bot' }, { value: 'list_pin', label: 'Top of your list' }, { value: 'none', label: 'Just in the list' },
      ] },
      { path: 'answersWorkerQuestions', title: 'Answers its workers’ questions', widget: 'boolean' },
      { path: 'managedBy', title: 'Manager and reviewed current manager', widget: 'json' },
      { path: 'ruleSuggestions', title: 'Selected rule intents', widget: 'json', required: true },
    ] },
    inputSchema: lazyZodSchema(() => z.extend(SessionCoordinatorEnableInputV1Schema, { sessionId: SessionTargetV1Schema })),
    outputSchema: SessionCoordinatorEnableResultV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'coordinator', 'enable'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.status.set_reason', approval: { result: 'none' },
    title: 'Explain session status',
    description: 'Set or clear an explanation for the current session without changing its runtime status.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_status_set_reason', voiceClientToolName: 'setSessionStatusReason' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    examples: { voice: { argsExample: '{"reason":"Waiting for the local build"}' } },
    inputHints: { fields: [{ path: 'reason', title: 'Explanation, or null to clear', widget: 'json', required: true }] },
    inputSchema: SessionStatusReasonSetInputSchema,
    outputSchema: SessionStatusReasonSetResultSchema,
    cli: { commands: [{ path: ['session', 'set-status-reason'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.title.set', approval: {result: 'none'},
    title: 'Set session title',
    description: 'Set the title (summary text) shown for a session.',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    bindings: { mcpToolName: 'session_title_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","title":"Fix flaky tests"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Rename a session.',
      title: 'Set title',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTitleSetInputSchema,
    cli: SESSION_TITLE_SET_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.bot.set', approval: {result: 'none'},
    title: 'Make a session a bot or a regular session',
    description: 'Set the reversible Bot marker through Account metadata without waking its execution host.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_bot_set', voiceClientToolName: 'setSessionBot' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Turn a session into a bot, or back into a regular session.', title: 'Set Bot marker', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'bot', title: 'Bot marker, or null for a regular session', widget: 'json', required: true },
    ] },
    inputSchema: BotSetInputSchema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'bot', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.memory.set', approval: {result: 'none'}, title: 'Use memory in this session',
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    description: 'Save the Session memory choice without creating or editing documents.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_memory_set', voiceClientToolName: 'setSessionMemory' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Choose whether a session uses your memory.', title: 'Use memory', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'enabled', title: 'Use memory', widget: 'json', required: true },
    ] },
    inputSchema: lazyZodSchema(() => z.extend(SessionMemorySetInputV1Schema, { sessionId: SessionTargetV1Schema })), outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'memory', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.voice.preference.set', approval: {result: 'none'}, title: 'Set session voice preference',
    description: 'Select one declared voice setting without changing provider or Account settings; null inherits Account settings.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_voice_preference_set', voiceClientToolName: 'setSessionVoicePreference' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Choose how Voice behaves in one session without changing your other sessions.', title: 'Session voice', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'preference', title: 'Voice preference, or null to inherit', widget: 'json', required: true },
    ] },
    inputSchema: SessionVoicePreferenceSetInputV1Schema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'voice', 'preference', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.context.update', approval: {result: 'none'}, title: 'Update session context',
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    description: 'Apply one context-entry, inherited-entry switch or Plan Doc selection intent against its reviewed metadata revision.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_context_update', voiceClientToolName: 'updateSessionContext' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Edit session context or select an existing Doc as its Plan with set_plan; a null entryId clears the selection.', title: 'Update context', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'intent', title: 'Context intent', widget: 'json', required: true },
    ] },
    inputSchema: lazyZodSchema(() => z.extend(SessionContextUpdateInputV1Schema, { sessionId: SessionTargetV1Schema })), outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'context', 'update'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.instructions.set', approval: {result: 'none'}, title: 'Set session instructions',
    description: 'Select or detach the reserved Session instruction entry; the document remains in the library.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_instructions_set', voiceClientToolName: 'setSessionInstructions' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Choose the instructions a session follows, or remove them.', title: 'Set instructions', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'ref', title: 'Document reference', description: 'Set it to null to detach the document.', widget: 'json', required: true },
    ] },
    inputSchema: SessionInstructionsSetInputV1Schema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'instructions', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    // Plan 60 §6: tool visibility belongs to the person reading the transcript;
    // automation must not hide its activity, even with an Action approval waiver.
    id: 'session.view.toolCalls.set', approval: {result: 'none'}, title: 'Show or hide session tool calls',
    description: 'Save a human-owned transcript view choice; null restores the session default.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    requiredAuthority: 'present_user',
    bindings: { voiceClientToolName: 'setSessionToolCalls' },
    surfaces: { ui: true, voice: true, agent: false, mcp: false, cli: true, rpc: false },
    inputHints: { description: 'Show or hide tool calls in a session\'s conversation.', title: 'Show tool calls', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'showToolCalls', title: 'Show tool calls, or null to use the default', widget: 'json', required: true },
    ] },
    inputSchema: SessionToolCallsSetInputSchema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'view', 'tools', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.permission_mode.set', approval: {result: 'none'},
    title: 'Set session permission mode',
    description: `Immediately update the permission intent (${SESSION_PERMISSION_INTENT_INPUTS.join('/')}) for the specified session. Compatible aliases are accepted. To apply a mode with the next prompt, use session.message.send with permissionModeOverride.`,
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_permission_mode_set', rpcMethod: 'session.permission_mode.set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","permissionMode":"read_only"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      description: 'Choose how much a session\'s agent may do without asking you.',
      title: 'Set permission mode',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
        { path: 'applyTiming', title: 'Apply timing', widget: 'select', options: [
          { value: 'immediate', label: 'Immediately' },
        ] },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPermissionModeSetInputSchema,
    cli: SESSION_PERMISSION_MODE_SET_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.model.set', approval: {result: 'none'},
    title: 'Set session model',
    description: 'Set the model override for the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_model_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","modelId":"default"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Choose the model a session uses.',
      title: 'Set session model',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'modelId', title: 'Model id', widget: 'text', required: true },
        { path: 'providerConnectionId', title: 'Provider connection id', widget: 'text' },
      ],
    },
    outputSchema: SessionModelSetResultV1Schema,
    inputSchema: SessionModelSetInputSchema,
    cli: SESSION_MODEL_SET_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.archive', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Archive session',
    description: 'Archive the specified session, optionally also archiving its unarchived direct reports. Each report retains its own rights and approval requirements; results include partial outcomes.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_archive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Move a session out of your list without deleting it.',
      title: 'Archive a session',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'alsoArchiveReports', title: 'Also archive direct sub-sessions', widget: 'boolean' },
      ],
    },
    outputSchema: lazyZodSchema(() => SessionArchiveActionResultV1Schema),
    inputSchema: lazyZodSchema(() => z.extend(SessionArchiveActionInputV1Schema, { sessionId: SessionTargetV1Schema })),
    cli: SESSION_ARCHIVE_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.delete', approval: {result: 'none'},
    hostReviewedChildren: (input: unknown) => [{ action: 'session.stop' as const, role: 'stop',
      input: { sessionId: (input as z.output<typeof SessionDeleteInputSchema>).sessionId } }],

    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    title: 'Delete session',
    description: 'Permanently delete a session. Its daemon removes managed folders through the durable deletion lifecycle.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_delete' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'DELETE', path: '/v1/sessions/:sessionId' },
    inputSchema: SessionDeleteInputSchema,
    outputSchema: lazyZodSchema(() => z.strictObject({ success: z.literal(true) })),
    inputHints: { description: 'Permanently delete a session and the folders Happier made for it.', title: 'Delete a session', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }] },
    cli: { commands: [{ path: ['session', 'delete'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.section.set', approval: {result: 'none'},
    title: 'Assign session section',
    description: 'Assign a session to an Account section, or return it to its own project with null.',
    safety: 'safe', sideEffectClass: 'external', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_section_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'PUT', path: '/v2/session-organization/folder-assignments/:sessionId' },
    inputSchema: lazyZodSchema(() => SessionSectionSetInputV1Schema),
    outputSchema: lazyZodSchema(() => SessionSectionSetResultV1Schema),
    inputHints: { description: 'Move a session to a section, or back to its project.', title: 'Assign session section', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'sectionId', title: 'Section id, or null to clear', widget: 'text', required: true },
    ] },
    cli: { commands: [{ path: ['session', 'section', 'set'], positionals: ['sessionId', 'sectionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.tags.set', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Assign session tags',
    description: 'Replace a session’s tag assignments with existing organization tag ids; an empty list clears them.',
    safety: 'safe', sideEffectClass: 'external', placements: [],
    bindings: { mcpToolName: 'session_tags_set', voiceClientToolName: 'session_tags_set' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'PUT', path: '/v2/session-organization/tag-assignments/:sessionId' },
    inputSchema: lazyZodSchema(() => z.extend(SetSessionTagAssignmentsRequestSchema, { sessionId: SessionTargetV1Schema })),
    outputSchema: SetSessionTagAssignmentsResponseSchema,
    inputHints: { description: 'Choose the tags on a session.', title: 'Assign session tags', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'tagIds', title: 'Tag ids', widget: 'textarea', required: true },
    ] },
    cli: { commands: [{ path: ['session', 'tags', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.space_membership.set', executionPlacement: 'client', approval: { result: 'none' },
    title: 'Change Space membership', description: 'Add, move, or remove explicit Space membership in the Session’s own Home and Account. Removing explicit membership may leave a saved-filter match.',
    safety: 'safe', sideEffectClass: 'external', placements: [],
    bindings: { mcpToolName: 'session_space_membership_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: SessionSpaceMembershipSetInputV1Schema, outputSchema: SessionSpaceMembershipSetResultV1Schema,
    inputHints: { title: 'Space membership', description: 'Choose the Space and its catalog Account.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'operation', title: 'Operation', widget: 'text', required: true },
      { path: 'spaceId', title: 'Space id', widget: 'text', required: true },
      { path: 'sourceSpaceId', title: 'Source Space id', widget: 'text' },
      { path: 'spaceSettingsTarget', title: 'Space catalog Home and Account', widget: 'textarea', required: true },
    ] },
    cli: { commands: [{ path: ['session', 'space-membership', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.unarchive', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Unarchive session',
    description: 'Unarchive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_unarchive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Bring an archived session back to your list.',
      title: 'Unarchive a session',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTargetRequiredInputSchema,
    cli: SESSION_UNARCHIVE_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.targets.resolve', sideEffectClass: 'read', approval: { result: 'none' },
    title: 'Preview session targets',
    description: 'Inspect the complete authorized target selection for a host or installed contributed Action without executing it. Final invocation prepares its own current selection.',
    safety: 'safe', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_targets_resolve', voiceClientToolName: 'session_targets_resolve', rpcMethod: 'session.targets.resolve' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: SessionTargetsResolveInputV1Schema,
    outputSchema: SessionTargetPreviewV1Schema,
    examples: { voice: { argsExample: '{"target":{"selector":"workers"},"actionId":"session.message.send"}' } },
    inputHints: { title: 'Preview session targets', fields: [
      { path: 'target', title: 'Session target', widget: 'json', required: true },
      { path: 'actionId', title: 'Action', description: 'Host Action id or canonical contributed Action id (<pluginId>/actions/<localId>) from discovery.', widget: 'text', required: true },
    ] },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'targets', 'resolve'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.status.get', sideEffectClass: 'read', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Get session status',
    description: 'Get summary status and the content-free Connected selection for a session. Use sessionId:"self" to read your own selection for reuse in child starts. Set includeAcceptedWorkspace:true to obtain result.acceptedWorkspace.checkout, the exact accepted checkout address for Project Actions such as projects.inspect. If absent, the accepted checkout identity is unavailable; do not infer it from the Session path. Optionally refresh live agent state or inspect current execution prerequisites.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'session_status_get', mcpToolName: 'session_status_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","live":true}' },
      voice: { argsExample: '{"sessionId":"session_123","readiness":true}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See whether a session is working, waiting or stopped.',
      title: 'Get session status',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'live', title: 'Live', widget: 'boolean' },
        { path: 'readiness', title: 'Inspect execution readiness', widget: 'boolean' },
      ],
    },
    outputSchema: lazyZodSchema(() => withSessionTargetFanoutResultV1(SessionStatusActionResultV1Schema)),
    inputSchema: SessionStatusGetInputSchema,
    cli: SESSION_STATUS_GET_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.work_state.get', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'Get session work state',
    description: 'Get the normalized current goal, task, and todo snapshot for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_work_state_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See a session\'s goal, current task and to-dos.',
      title: 'Get session work state',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.goal.get', sideEffectClass: 'read', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Get session goal',
    description: 'Get the editable session goal when the provider supports native goals.',
    safety: 'safe',
    toolExposure: { agent: 'direct' },
    placements: [],
    bindings: { mcpToolName: 'session_goal_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See the goal a session is working towards.',
      title: 'Get session goal',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTargetRequiredInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.goal.set', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Set session goal',
    description: 'Set or update the native session goal.',
    safety: 'safe',
    toolExposure: { agent: 'direct' },
    placements: [],
    bindings: { mcpToolName: 'session_goal_set', rpcMethod: SESSION_RPC_METHODS.SESSION_GOAL_SET },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","objective":"Ship goal controls"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Set the goal a session works towards.',
      title: 'Set session goal',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'objective', title: 'Objective', widget: 'textarea' },
        { path: 'status', title: 'Status', widget: 'text' },
        { path: 'tokenBudget', title: 'Token budget', widget: 'text' },
        { path: 'resumeInactiveWithInitialGoal', title: 'Resume inactive session with goal', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionGoalSetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.goal.clear', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Clear session goal',
    description: 'Clear the native session goal.',
    safety: 'safe',
    toolExposure: { agent: 'direct' },
    placements: [],
    bindings: { mcpToolName: 'session_goal_clear' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Remove a session\'s goal.',
      title: 'Clear session goal',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTargetRequiredInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);



export const SESSION_MODEL_UNARM_ACTION_SPECS = Object.freeze([
  {
    id: 'session.model.unarm', approval: {result: 'none'}, title: 'Cancel armed model switch',
    description: 'Restore the running Session’s applied route and model for the next message.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'session', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'session_model_unarm' },
    inputSchema: lazyZodSchema(() => z.strictObject({ sessionId: z.string().check(z.minLength(1)) })),
    outputSchema: SessionModelTransitionResultV1Schema,
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }] },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'model', 'unarm'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
] as const);

