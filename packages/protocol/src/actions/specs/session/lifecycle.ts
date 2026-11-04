import { redactObservationInputPaths } from '../observationRedaction.js';

/** Raw launch environment and private account selections never enter shared Action history. */
export const projectSessionSpawnNewObservationInput = redactObservationInputPaths('environmentVariables', 'connectedServices');

import { projectSessionSpawnNewActionInputV2 } from '../../../sessions/creation/sessionSpawnNewInputV2.js';
import { SessionSpawnNewResultV1Schema, SessionSpawnNewActionResultV1Schema, readSessionSpawnNewActionResultV1 } from '../../../sessions/creation/sessionSpawnNewResultV1.js';
import type { ActionSurfaceBindingContext, PreNormalizedActionSpec } from '../definition.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SessionTargetV1Schema } from '../../sessionTargetV1.js';
import { SessionForkRpcParamsSchema } from '../../../sessions/fork.js';
import { SessionResumeRequestV1Schema } from '../../../sessions/control/sessionResumeRequestV1.js';
import { z } from 'zod/mini';
import { SCM_COMPARISON_VIEWS, ScmComparisonSourceSchema } from '../../../scm/comparison.js';
import { type ActionInputHints } from '../../metadata.js';
import type { ExternalActionTargetV1 } from '../../externalActionApi.js';
import { type ActionInputOption } from '../../actionInputHints.js';
import { SessionSpawnNewInputV2Schema, SessionSpawnNewActionInputV2Schema, SessionSpawnNewActionInputV2BaseSchema } from '../../../sessions/creation/sessionSpawnNewInputV2.js';
import { refineSessionDirectoryIntentCheckoutV1 } from '../../../sessions/creation/sessionDirectoryIntentV1.js';
import { AGENT_PERMISSION_INTENTS_V1 } from '../../../runtime/permissionIntentV1.js';
import { SessionCreationKeyV1Schema } from '../../../sessions/creation/sessionCreationIdentityV1.js';
import { SessionRollbackTargetSchema } from '../../../sessions/rollback.js';
import { CheckpointCodeRollbackActionRequestSchema, CheckpointCodeRollbackResultSchema } from '../../../sessions/control/rollback/checkpointCodeRollback.js';
import { SessionCheckpointRequestV1Schema, SessionCheckpointResultV1Schema, SessionRestoreRequestV1Schema, SessionRestoreResultV1Schema } from '../../../sessions/control/checkpoints/v1.js';
import { SessionHandoffAbortRequestSchema, SessionHandoffCommitRequestSchema, SessionHandoffPrepareTargetResultGetRequestSchema, SessionHandoffPrepareTargetResultGetResponseSchema, SessionHandoffPrepareTargetRequestSchema, SessionHandoffPrepareTargetResumeRequestSchema, SessionHandoffPrepareTargetResumeResponseSchema, SessionHandoffStatusGetRequestSchema, SessionHandoffActionResultV1Schema, refineSessionHandoffStateTransferV3 } from '../../../sessions/control/handoff/handoffSchemas.js';
import { SessionHandoffStateTransferSchema } from '../../../sessions/control/handoff/handoffTypes.js';
import { HandoffTargetReplacementApprovalV1Schema } from '../../../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import { HandoffWorkspaceActionV1Schema } from '../../../sessions/control/handoff/workspaceSyncSchemas.js';
import { SessionContinueWithReplayRpcParamsSchema } from '../../../sessions/continueWithReplay.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../rpc/methods.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';


export const SessionOpenInputSchema = lazyZodSchema(() => z.strictObject({
  presentation: z.optional(z.enum(['main', 'overlay', 'window'])),
  tabId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.optional(SessionTargetV1Schema),
  sessionTitle: z.optional(z.string().check(z.trim(), z.minLength(1))),
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  approvedNewDirectoryCreation: z.optional(z.boolean()),
  intent: z.optional(z.literal('resume')),
  resumeRequest: z.optional(SessionResumeRequestV1Schema),
  destination: z.optional(z.strictObject({
    kind: z.literal('scmReview'),
    comparison: ScmComparisonSourceSchema,
    view: z.enum(SCM_COMPARISON_VIEWS),
    explain: z.optional(z.boolean()),
    comparisonId: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
  })),
}).check(z.superRefine((value, ctx) => {
  if (value.resumeRequest && (value.intent !== 'resume' || value.tabId || value.destination || value.presentation
    || value.resumeRequest.sessionId !== value.sessionId)) ctx.addIssue({
      code: 'custom', path: ['resumeRequest'], message: 'Resume request requires its exact headless Session address',
    });
  if ((value.sessionId === undefined || typeof value.sessionId === 'string' && !value.sessionId.trim())
    && !(typeof value.sessionTitle === 'string' && value.sessionTitle.trim().length > 0)) {
    ctx.addIssue({
      code: "custom",
      message: 'sessionId or sessionTitle is required',
      path: ['sessionId'],
    });
  }
})));

export const SessionForkInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(SessionForkRpcParamsSchema, {
  v: true,
  parentSessionId: true,
}), {
  sessionId: z.optional(z.string().check(z.minLength(1))),
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  forkPoint: z.optional(SessionForkRpcParamsSchema.shape.forkPoint),
})));

export const SessionRollbackInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  target: z.optional(SessionRollbackTargetSchema),
}));

/**
 * Outcome-oriented public handoff input. Workspace endpoint identity and the
 * settings version that proves it are daemon-owned: the coordinator resolves or
 * materializes both `WorkspaceRef` values from the Account settings owner, so a
 * caller can neither name nor pin them here.
 */
export const SessionHandoffInputFieldsSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(SessionTargetV1Schema),
  sourceMachineId: z.optional(z.string().check(z.minLength(1))),
  targetMachineId: z.optional(z.string().check(z.minLength(1))),
  targetPath: z.optional(z.string().check(z.minLength(1))),
  sessionStorageMode: z.optional(z.enum(['direct', 'persisted'])),
  targetSessionStorageMode: z.optional(z.enum(['direct', 'persisted'])),
  stateTransfer: z.optional(SessionHandoffStateTransferSchema),
  preferredTransportStrategies: z.optional(z.array(z.enum(['direct_peer', 'server_routed_stream'])).check(z.maxLength(2))),
  workspaceAction: z.optional(HandoffWorkspaceActionV1Schema),
  accountServerId: z.optional(z.string().check(z.minLength(1))),
  actionRequestId: z.optional(z.string().check(z.minLength(1), z.maxLength(2_000))),
  handoffTargetReplacementApproval: z.optional(HandoffTargetReplacementApprovalV1Schema),
  handoffTargetReplacementApprovalReceiptId: z.optional(z.string().check(z.minLength(1), z.maxLength(2_000))),
  handoffTargetReplacementApprovalActionInput: z.optional(z.unknown()),
}));

export const SessionHandoffInputSchema = lazyZodSchema(() => SessionHandoffInputFieldsSchema.check(z.superRefine(refineSessionHandoffStateTransferV3)));

export const SessionHandoffPublicInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(SessionHandoffInputFieldsSchema, {
  sourceMachineId: true,
  sessionStorageMode: true,
  preferredTransportStrategies: true,
  accountServerId: true,
  actionRequestId: true,
  handoffTargetReplacementApproval: true,
  handoffTargetReplacementApprovalReceiptId: true,
  handoffTargetReplacementApprovalActionInput: true,
})).check(z.superRefine(refineSessionHandoffStateTransferV3)));

export const SessionSpawnNewInputSchema = SessionSpawnNewActionInputV2Schema;
/** Ordinary terminal callers do not own negotiated committed-observer lifecycle. */
export const SessionSpawnNewTerminalInputSchema = lazyZodSchema(() => z.omit(SessionSpawnNewActionInputV2BaseSchema, {
  observeSessionCommit: true,
}).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));
export const SessionSpawnNewApiInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(SessionSpawnNewActionInputV2BaseSchema, {
  executionTarget: true,
  observeSessionCommit: true,
})).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));
export const SessionSpawnNewInputHints = {
  title: 'Create a new session',
  description: 'Start a session with an agent on one of your machines.',
  fields: [
    { path: 'creationKey', title: 'Creation key', widget: 'text' },
    { path: 'executionTarget.serverId', title: 'Server id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.servers.available' },
    { path: 'executionTarget.machineId', title: 'Machine id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.machines.available' },
    { path: 'directory', title: 'Directory intent', widget: 'json', required: true, optionsSourceId: 'sessions.spawn.paths.recent' },
    { path: 'organizationPlacement', title: 'Organization placement', widget: 'json' },
    { path: 'agentTarget', title: 'Agent target', description: 'Backend options carry target keys. For agent:<pluginId>/<localId>, use {kind:"agent",identity:{pluginId,localId}}; retain definitionId for a configured Agent.', widget: 'json', required: true, optionsSourceId: 'agents.backends.enabled' },
    { path: 'modelSelection', title: 'Model selection', description: 'Native model options carry a model id in option.value. Use {v:1,ref:{agentTargetKey,providerConnectionId:null,modelId:option.value},updatedAt:<milliseconds>}, with the selected Agent target key. Provider catalog choices retain their structured ref. A Connected Account profile is not a providerConnectionId.', widget: 'json', optionsSourceId: 'agents.models.available' },
    { path: 'title', title: 'Title', widget: 'text' },
    { path: 'permissionMode', title: 'Permission mode', description: `Canonical intent: ${AGENT_PERMISSION_INTENTS_V1.join(', ')}. Use "read-only" for read-only access.`, widget: 'text' },
    { path: 'allowedTools', title: 'Allowed tool rules', widget: 'json' },
    { path: 'unlistedTools', title: 'Unlisted tools', widget: 'select',
      options: [{ value: 'ask', label: 'Ask for approval' }, { value: 'deny', label: 'Deny without asking' }] },
    { path: 'agentModeId', title: 'Agent mode', widget: 'text', optionsSourceId: 'agents.session_modes.available' },
    { path: 'configuration', title: 'Configuration', description: 'Optional full snapshot: {mode:{value:null,updatedAtMs:0},model:{value:null,updatedAtMs:0},permissionIntent:{value:null,updatedAtMs:0},options:{}}. Set model.value to a model-id string or null, permissionIntent.value to a canonical intent or null, and options[option.value] to {value:<scalar>,updatedAtMs:<milliseconds>}. For model-scoped choices, first supply draftInput.modelSelection or draftInput.configuration.model; without a selected model the inventory contains only session-wide options. Config-option choices name option ids, not snapshots or selected values; read agents.config_options.list with modelId for their value choices. Omit configuration when no override is needed.', widget: 'json', optionsSourceId: 'agents.config_options.available' },
    { path: 'profileId', title: 'Profile id', widget: 'text', optionsSourceId: 'sessions.spawn.profiles.available' },
    { path: 'connectedServices', title: 'Connected services', description: 'From an Agent Session, omission inherits the parent Connected selection when the child resolves to the same Agent. Root starts and other Agents use Account defaults. Pass an explicit binding object to override; {v:2,bindingsByServiceId:{}} requests native authentication. Read your Session selection through session.status.get. Pass the selected option.value through this schema; a Connected Account profile id is not a modelSelection.ref.providerConnectionId.', widget: 'json', optionsSourceId: 'sessions.spawn.connected_services.available' },
    { path: 'capabilitySelection', title: 'Capability selection', widget: 'json', optionsSourceId: 'sessions.spawn.capabilities.preview' },
    { path: 'transcriptStorage', title: 'Transcript storage', widget: 'text' },
    { path: 'terminal', title: 'Terminal', widget: 'json' },
    { path: 'checkoutCreationDraft', title: 'Checkout creation', widget: 'json' },
    { path: 'initialInput.text', title: 'Initial message', widget: 'textarea' },
    { path: 'initialInput.attachments', title: 'Initial attachments', widget: 'json' },
    { path: 'agentSessionStartupInstructionsV1', title: 'Startup instructions', widget: 'json' },
  ],
} satisfies ActionInputHints;
export const SessionSpawnNewApiInputHints = {
  ...SessionSpawnNewInputHints,
  fields: SessionSpawnNewInputHints.fields.filter((field) => (
    field.path !== 'executionTarget.serverId' && field.path !== 'executionTarget.machineId'
  )),
} satisfies ActionInputHints;

/**
 * The sole canonical-to-public projection for a Session creation request that
 * was already admitted on a local Action surface. Execution placement remains
 * transport metadata: the public input cannot carry it, while the selected
 * machine reaches the API envelope as its exact target.
 */
export function projectSessionSpawnNewApiRequest(
  value: unknown,
): Readonly<{
  input: z.input<typeof SessionSpawnNewApiInputSchema>;
  target: Extract<ExternalActionTargetV1, { kind: 'machine' }>;
}> {
  const canonicalInput = SessionSpawnNewActionInputV2Schema.parse(value);
  const { executionTarget, observeSessionCommit: _observer, ...apiInput } = canonicalInput;
  return {
    input: SessionSpawnNewApiInputSchema.parse(apiInput),
    target: {
      kind: 'machine',
      machineId: executionTarget.machineId,
    },
  };
}

// Action invocations may derive a key from their durable request identity, but
// RPC retries have no such identity. The transport therefore requires the
// caller's one logical creation key rather than synthesizing one per attempt.
export const SessionSpawnNewRpcInputSchema = lazyZodSchema(() => z.safeExtend(SessionSpawnNewInputV2Schema, {
  creationKey: SessionCreationKeyV1Schema,
}));

export function bindApiSessionSpawnNewInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const input = SessionSpawnNewApiInputSchema.parse(value);
  const serverId = context.serverId;
  const target = context.externalActionTarget;
  if (
    context.caller.kind !== 'host'
    || typeof serverId !== 'string'
    || serverId.trim().length === 0
    || target?.kind !== 'machine'
  ) {
    throw new Error('API session spawn requires a host-stamped machine target and server id');
  }

  return {
    ...input,
    executionTarget: {
      serverId,
      machineId: target.machineId,
    },
  };
}

export const CHECKPOINT_SCOPE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'conversation', label: 'Conversation' },
  { value: 'workspace', label: 'Workspace' },
];

export const CHECKPOINT_SOURCE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'happier_scm', label: 'Happier SCM' },
  { value: 'composed', label: 'Composed' },
];

export const SESSION_LIFECYCLE_ACTION_SPECS = Object.freeze([
  {
    id: 'session.open', approval: {result: 'optional',flow: 'deferred'},
    executionPlacements: ['session', 'client'],
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    // Navigation belongs to the answering client, including CLI requests.
    // Only explicit resume without a Workspace destination is headless.
    executionPlacementForInput: (input: unknown) =>
      typeof input === 'object' && input !== null && 'intent' in input && input.intent === 'resume'
        && !('destination' in input) && !('tabId' in input) && !('presentation' in input) ? 'session' : 'client',
    title: 'Open session',
    description: 'Open or resume a session, including Files, Walkthrough or pending-only Commits for an SCM comparison. Explicit fresh-folder consent lets the daemon recover a missing managed folder.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'openSession', mcpToolName: 'session_open' },
    examples: {
      voice: { argsExample: '{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}' },
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
      description: 'Open a session, or resume it if it has stopped.',
      title: 'Open a session',
      fields: [
        { path: 'tabId', title: 'Workspace tab id (optional)', widget: 'text' },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
        { path: 'presentation', title: 'Presentation', widget: 'select', options: [
          { value: 'main', label: 'In Happier' }, { value: 'overlay', label: 'In the overlay' }, { value: 'window', label: 'In a window' },
        ] },
        { path: 'approvedNewDirectoryCreation', title: 'Continue in a fresh folder if the private folder is missing', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionOpenInputSchema,
    cli: { commands: [{ path: ['session', 'open'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.fork', approval: {result: 'optional',flow: 'deferred'},
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
      presentation: { onStart: 'current' },
    },
    title: 'Fork session',
    sideEffectClass: 'write',
    description: 'Create a new session from the latest state or a selected message using Native or Replay.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info', 'command_palette', 'slash_command', 'voice_panel', 'agent_input_chips'],
    slash: { tokens: ['fork'] },
    bindings: {
      voiceClientToolName: 'forkSession',
      mcpToolName: 'session_fork',
      rpcMethod: 'session.fork',
      rpcMethodAliases: [RPC_METHODS.SESSION_FORK_PROVIDER_SAFE],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Fork a session',
      description: 'Fork from the latest state or a selected message, using Native or Replay.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'strategy', title: 'Fork strategy (optional)', widget: 'select', options: [
          { value: 'native', label: 'Native' }, { value: 'replay', label: 'Replay' }, { value: 'auto', label: 'Automatic' },
        ] },
        { path: 'forkPoint', title: 'Fork point (optional)', widget: 'json' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionForkInputSchema,
    cli: { commands: [{ path: ['session', 'fork'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.continue_with_replay', approval: {result: 'optional',flow: 'deferred'},
    title: 'Continue session with replay',
    description: 'Create a continuation session from a replay seed while preserving the existing RPC wire contract.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.continueWithReplay' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Start a new session that picks up where an earlier one left off.',
      title: 'Continue with replay',
      fields: [
        { path: 'directory', title: 'Directory', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target', widget: 'text', required: true },
        { path: 'replay', title: 'Replay seed', widget: 'textarea', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionContinueWithReplayRpcParamsSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.rollback', approval: {result: 'required',flow: 'deferred'},
    title: 'Rollback conversation',
    description: 'Roll back conversation state in the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'session.rollback' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Rollback a session conversation',
      description: 'Rewinds conversation state for the selected session.',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRollbackInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.checkpoint_code_rollback', approval: {result: 'required',flow: 'deferred'},
    title: 'Rollback code to checkpoint',
    description: 'Apply a checkpoint-backed code rollback for the selected session turn.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Rollback session code to a checkpoint',
      description: 'Creates a mandatory backup checkpoint before applying a same-worktree reverse patch.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text', required: true },
      ],
    },
    outputSchema: CheckpointCodeRollbackResultSchema,
    inputSchema: CheckpointCodeRollbackActionRequestSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.checkpoint', approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Create checkpoint',
    description: 'Create a source-qualified checkpoint for the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Create a session checkpoint',
      description: 'Creates a checkpoint through a selected provider or Happier SCM source.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionCheckpointResultV1Schema,
    inputSchema: SessionCheckpointRequestV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.restore', approval: {result: 'optional',flow: 'deferred'},
    title: 'Restore checkpoint',
    description: 'Restore a selected session checkpoint source.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_RESTORE },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Restore a session checkpoint',
      description: 'Restores from an explicit provider or Happier SCM checkpoint source.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
        { path: 'candidate.source', title: 'Source', widget: 'select', options: CHECKPOINT_SOURCE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionRestoreResultV1Schema,
    inputSchema: SessionRestoreRequestV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.handoff', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    sideEffectClass: 'write',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    operationReentry: snapshot => snapshot.state === 'running' ? 'reinvoke'
      : snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled' ? 'replay' : 'refuse',
    title: 'Hand off session',
    description: 'Move the current session to another machine or another directory on the same machine while keeping the same session id. Select target storage and workspace transfer behavior explicitly when needed.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info'],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_START],
      sdkMethod: 'session.handoff.start',
      mcpToolName: 'session_handoff',
      voiceClientToolName: 'session_handoff',
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","targetMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Hand off a session',
      description: 'Move to another machine or directory on the same machine. The daemon resolves the source and workspace endpoints.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text' },
        { path: 'targetPath', title: 'Target directory', widget: 'text',
          description: 'Destination path on the target machine, including a directory move on the source machine.' },
        { path: 'targetSessionStorageMode', title: 'Target session storage', widget: 'select', options: [
          { value: 'direct', label: 'Direct' }, { value: 'persisted', label: 'Persisted' },
        ] },
        { path: 'workspaceAction', title: 'Workspace transfer', widget: 'json',
          description: 'Workspace intent: none, copy_once, create_relationship, relationship or linked_workspace, with the fields required by that intent. Omit to leave workspace intent unspecified.' },
      ],
    },
    outputSchema: SessionHandoffActionResultV1Schema,
    inputSchema: SessionHandoffInputSchema,
    surfaceBindings: {
      api: { inputSchema: SessionHandoffPublicInputSchema },
      plugin: { inputSchema: SessionHandoffPublicInputSchema },
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.handoff.prepare_target', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Prepare session handoff target',
    description: 'Prepare a target machine to receive an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET],
      sdkMethod: 'session.handoff.prepareTarget.start',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Get another machine ready to take over a running session.',
      title: 'Prepare handoff target',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'sourceMachineId', title: 'Source machine id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffPrepareTargetRequestSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.handoff.prepare_target_result.get', sideEffectClass: 'read', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Get session handoff target preparation result',
    description: 'Read the prepared-target result for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'See whether the machine taking over a session is ready.',
      title: 'Get handoff prepare-target result',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: SessionHandoffPrepareTargetResultGetResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResultGetRequestSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.handoff.prepare_target.resume', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Resume interrupted session handoff target preparation',
    description: 'Explicitly continue one interrupted prepare-target job at its current durable revision.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3 },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      description: 'Continue getting a machine ready to take over a session after an interruption.',
      title: 'Resume interrupted handoff preparation',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'jobId', title: 'Job id', widget: 'text', required: true },
        { path: 'expectedRevision', title: 'Expected revision', widget: 'text', required: true },
        { path: 'attemptId', title: 'Attempt id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionHandoffPrepareTargetResumeResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResumeRequestSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.handoff.commit', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Commit session handoff',
    description: 'Finalize a prepared session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Finish moving a session to the machine that is ready for it.',
      title: 'Commit handoff',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffCommitRequestSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.handoff.abort', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Abort session handoff',
    description: 'Cancel an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Cancel moving a session to another machine; it stays where it is.',
      title: 'Abort handoff',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'reason', title: 'Reason', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffAbortRequestSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.handoff.status.get', sideEffectClass: 'read', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Get session handoff status',
    description: 'Read scalar status for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'See how a session\'s move to another machine is going.',
      title: 'Get handoff status',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffStatusGetRequestSchema,
  } satisfies PreNormalizedActionSpec,
] as const);



export const SESSION_SPAWN_ACTION_SPECS = Object.freeze([
  {
    id: 'session.spawn_new', originalExecution: { accountRoot: 'allowed', terminalRoot: 'host' }, approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    operationReentry: snapshot => {
      if (snapshot.state === 'running') return 'resume';
      if (snapshot.state === 'succeeded') {
        const settlement = SessionSpawnNewActionResultV1Schema.safeParse(snapshot.result);
        if (settlement.success && settlement.data.type === 'error' && settlement.data.retryable) return 'fresh';
        return 'replay';
      }
      return snapshot.state === 'failed' || snapshot.state === 'cancelled' ? 'replay' : 'refuse';
    },
    title: 'Create session',
    description: 'Create a new session on the requested machine using the selected Agent. Pass directory {kind:"path",path} for a folder or {kind:"managed"} for no folder: Happier creates a private folder for this session.',
    sideEffectClass: 'write',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: {
      rpcMethod: RPC_METHODS.SESSION_SPAWN_NEW,
      voiceClientToolName: 'spawnSession',
      mcpToolName: 'session_spawn_new',
    },
    surfaceBindings: {
      mcp: { inputSchema: SessionSpawnNewTerminalInputSchema },
      api: {
        inputSchema: SessionSpawnNewApiInputSchema,
        bindInput: bindApiSessionSpawnNewInput,
        inputHints: SessionSpawnNewApiInputHints,
      },
      rpc: {
        inputSchema: SessionSpawnNewRpcInputSchema,
        decodeInput: value => projectSessionSpawnNewActionInputV2(SessionSpawnNewRpcInputSchema.parse(value)),
        outputSchema: SessionSpawnNewResultV1Schema,
        encodeOutput: value => readSessionSpawnNewActionResultV1(SessionSpawnNewActionResultV1Schema.parse(value)),
      },
    },
    examples: {
      voice: { argsExample: '{"executionTarget":{"serverId":"active","machineId":"machine-1"},"directory":{"kind":"path","path":"/workspace/project"},"agentTarget":{"kind":"agent","identity":{"pluginId":"happier.agent.claude","localId":"claude"}},"initialInput":{"text":"Help me inspect this workspace."}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: SessionSpawnNewInputHints,
    cli: { commands: [], inputSchema: SessionSpawnNewTerminalInputSchema, wholeInputSchema: SessionSpawnNewTerminalInputSchema },
    outputSchema: SessionSpawnNewActionResultV1Schema,
    projectObservationInput: projectSessionSpawnNewObservationInput,
    approvalPresentation: { summary: () => null, projectInput: projectSessionSpawnNewObservationInput, inputSchema: SessionSpawnNewInputSchema },
    inputSchema: SessionSpawnNewInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);
